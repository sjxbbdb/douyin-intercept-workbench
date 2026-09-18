'use strict'

// license-server/server.js
//
// 授权中心入口。
//
// 启动顺序（顺序有依赖）：
//   1. 读配置（含密钥与安全项校验）
//   2. 打开数据库并执行迁移（失败即退出，不带病启动）
//   3. 装配路由
//   4. 监听（默认只绑回环）
//
// ⚠️ 这是纯 HTTP 服务，**不含 HTTPS**。对外必须经反向代理 + 证书，
//    否则 token 与 HMAC 签名密钥会明文传输。

const http = require('node:http')
const { loadConfig } = require('./config')
const { openDatabase } = require('./store/db')
const { Router, readJsonBody, sendJson, sendError } = require('./api/router')
const M = require('./api/middleware')
const { Logger } = require('./api/logger')
const { signResponseRaw } = require('./crypto/sign')
const { AppError } = require('../shared/lib/errors')
const { sha256Hex } = require('./crypto/sign')
const auth = require('./api/routes-auth')
const audit = require('./api/routes-audit')
const credit = require('./api/routes-credit')

const API = '/api/v1'
const HEADER_SERVER_TS = 'X-Lic-Server-Ts'
const HEADER_SIGN = 'X-Lic-Sign'

/**
 * 把受保护接口的响应按契约 §5.2 签名。
 *
 * ⚠️ 三个要点：
 *   1. 先序列化再签名再发送——签的必须是**实际发出的字节**
 *   2. 签名覆盖 `request_nonce`，把响应绑定到这一次请求，
 *      防止旧响应被重放给新请求（如重放"余额充足"）
 *   3. **错误响应也要签名**（含 402/409/4xx/5xx），否则客户端
 *      无法区分"服务端说余额不足"与"中间人伪造余额不足"
 */
function sendSigned(res, { session, requestNonce, status, payload, pathWithQuery, nowMs, log }) {
  const body = JSON.stringify(payload)
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  }

  if (session && session.sign_key_plain) {
    const sign = signResponseRaw({
      signKey: session.sign_key_plain,
      httpStatus: status,
      pathWithQuery,
      requestNonce: requestNonce || '',
      serverTimeMs: nowMs,
      rawBody: body,
    })
    headers[HEADER_SERVER_TS] = String(nowMs)
    headers[HEADER_SIGN] = sign
  } else {
    // ⚠️ 无法签名的情况：会话未建立或已被吊销（401/403 身份类错误）。
    //    此时没有可用密钥，**只能返回未签名响应**。
    //
    //    契约 §5.2 要求签名的是「余额不足 / 策略收紧」这类**业务错误**——
    //    它们都发生在会话有效时，因此总能签名。
    //    而 401/403 是**身份问题**，客户端收到后的正确动作是重新登录，
    //    而不是判为"连接被篡改"。
    //
    //    为让客户端能可靠区分这两种情况，这里显式声明未签名原因。
    headers['X-Lic-Unsigned'] = status === 401 || status === 403
      ? 'auth'          // 身份问题：客户端应重新登录
      : 'no_session'    // 其他：不应出现在受保护接口的正常路径上

    // ⚠️ 未签名响应也带 `X-Lic-Server-Ts`。
    //    它不是"签名"，只是服务端时间的声明，客户端**不会**据此放宽
    //    任何真实性判定（业务响应一律必须验签）。
    //    但它解决一个真实死锁：
    //      · 登录响应是未签名的（密钥就在响应体里），客户端**唯一**能
    //        获得服务端时间的时机就是这里；
    //      · 没有它，本机时钟偏差 > 5 分钟的客户端会在第一次签名请求时
    //        收到 AUTH_TS_SKEW，而那条 401 同样未签名 → 拿不到时间 →
    //        无法自愈，表现为"登录成功但什么都做不了"。
    headers[HEADER_SERVER_TS] = String(nowMs)
  }

  res.writeHead(status, headers)
  res.end(body)
}

function buildRouter() {
  const r = new Router()

  // ── 公开（无需 token）────────────────────────────────────
  r.get('/healthz', async (ctx) => ({
    ok: true,
    service: 'dy-license',
    protocol_version: ctx.config.protocolVersion,
    server_time_ms: ctx.nowMs,
    uptime_ms: ctx.nowMs - ctx.startedAtMs,
  }))

  r.get(`${API}/client/bootstrap`, async (ctx) =>
    auth.bootstrap({ ...ctx, query: queryOf(ctx) }))

  r.post(`${API}/auth/login`, async (ctx) => {
    await attachBody(ctx)
    return auth.login(ctx)
  })

  // ── 需 token，但**不签名**（契约允许用过期 token 续期）──────
  r.post(`${API}/auth/refresh`, async (ctx) => {
    await attachBody(ctx)
    return withToken(ctx, (c) => auth.refresh(c))
  })

  r.post(`${API}/auth/logout`, async (ctx) => {
    await attachBody(ctx)
    return withToken(ctx, (c) => auth.logout(c))
  })

  // ── 需 token + 签名 + 防重放 ──────────────────────────────
  // ⚠️ 顺序要点：受保护的 POST 必须**先解析 body 再进 guard**。
  //    guard 需要两样东西：
  //      · ctx.rawBody —— 签的是 sha256(原始字节)（契约 §5.1）
  //      · ctx.body    —— 取 seq 做防重放判定
  //    若把 attachBody 放在 handler 内部（guard 之后），guard 拿到的
  //    就是空 body → 签名校验失败 / seq 判定为 undefined。
  r.get(`${API}/auth/me`, M.guard(null, async (ctx) => auth.me(ctx)))

  r.post(`${API}/heartbeat`, async (ctx) => {
    await attachBody(ctx)
    return M.guard('heartbeat', async (c) => audit.heartbeat(c))(ctx)
  })

  r.get(`${API}/policy/current`, M.guard(null, async (ctx) => audit.policyCurrent(ctx)))

  r.post(`${API}/audit/sends`, async (ctx) => {
    await attachBody(ctx)
    return M.guard('sends', async (c) => audit.auditSends(c))(ctx)
  })

  r.post(`${API}/audit/config-changes`, async (ctx) => {
    await attachBody(ctx)
    return M.guard('config_audit', async (c) => audit.auditConfigChanges(c))(ctx)
  })

  r.post(`${API}/usage/report`, async (ctx) => {
    await attachBody(ctx)
    return M.guard('usage', async (c) => audit.usageReport(c))(ctx)
  })

  r.get(`${API}/credit/balance`, M.guard(null, async (ctx) =>
    credit.creditBalance({ ...ctx, query: queryOf(ctx) })))

  r.get(`${API}/credit/ledger`, M.guard(null, async (ctx) =>
    credit.creditLedger({ ...ctx, query: queryOf(ctx) })))

  r.get(`${API}/account/plan`, M.guard(null, async (ctx) => credit.accountPlan(ctx)))

  r.post(`${API}/credit/redeem`, async (ctx) => {
    await attachBody(ctx)
    return M.guard('usage', async (c) => credit.redeem(c))(ctx)
  })

  return r
}

/**
 * 解析请求体并挂到 ctx。
 *
 * ⚠️ 必须在 guard 之前调用（在 handler 内部第一步）。
 *    因为签名校验需要**原始字节**（契约 §5.1 签 sha256(raw_body)），
 *    而 seq 需要解析后的 body。
 */
async function attachBody(ctx) {
  if (ctx.rawBody !== undefined) return
  const { raw, parsed } = await readJsonBody(ctx.req)
  ctx.rawBody = raw
  ctx.body = parsed
}

function queryOf(ctx) {
  return Object.fromEntries(new URL(ctx.rawUrl, 'http://x').searchParams)
}

/**
 * 只校验 token、不做签名与 seq 的包装。
 *
 * ⚠️ 为什么 refresh/logout 例外：契约允许用**已过期**的 token 调 refresh
 *    （否则过期即必须重输密码，体验不可接受）。而签名需要有效会话密钥。
 */
async function withToken(ctx, handler) {
  const token = M.extractToken(ctx.req)
  if (!token) throw new AppError('AUTH_TOKEN_MISSING', '请求未携带 token')

  const row = ctx.db.prepare(`
    SELECT s.*, a.account, a.display_name, a.status AS account_status,
           a.plan_expires_ms, a.first_login_ms
    FROM device_session s JOIN account a ON a.account_id = s.account_id
    WHERE s.token_hash = ?
  `).get(sha256Hex(token))

  if (!row) throw new AppError('AUTH_TOKEN_INVALID', 'token 无法识别，请重新登录')
  if (row.revoked_at_ms) throw new AppError('AUTH_TOKEN_REVOKED', '会话已吊销，请重新登录')

  return handler({ ...ctx, session: row })
}

/** 创建服务实例（不监听）。便于集成测试直接调用。 */
function createServer(options = {}) {
  const config = options.config || loadConfig(options)
  const log = options.logger || new Logger(config.logLevel, options.logSink || process.stdout)
  const { db, applied, close } = openDatabase(config.dbPath, {
    backupBeforeMigrate: options.backupBeforeMigrate,
    verbose: options.verbose,
  })

  if (applied.length) log.info('migrations_applied', { count: applied.length, versions: applied })

  const router = buildRouter()
  const startedAtMs = Date.now()

  const server = http.createServer(async (req, res) => {
    const nowMs = Date.now()
    const parsed = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
    const pathWithQuery = req.url

    const ctx = {
      req, res, db, config, log, nowMs, startedAtMs,
      pathname: parsed.pathname,
      rawUrl: pathWithQuery,
      headers: req.headers,
      body: null,
      rawBody: undefined,
      session: null,
      requestNonce: null,
    }

    try {
      const hit = router.match(req.method, parsed.pathname)
      if (!hit) {
        if (router.hasPath(parsed.pathname)) {
          return sendJson(res, 405, {
            ok: false, code: 'AUTH_INVALID_REQUEST', message: `${req.method} 不被支持`,
          })
        }
        return sendJson(res, 404, {
          ok: false, code: 'AUTH_INVALID_REQUEST', message: 'not found',
        })
      }

      const result = await hit.handler(ctx)
      if (res.writableEnded) return

      return sendSigned(res, {
        session: ctx.session, requestNonce: ctx.requestNonce,
        status: 200, payload: result, pathWithQuery, nowMs, log,
      })
    } catch (err) {
      if (res.writableEnded) return

      const appErr = err instanceof AppError ? err : null
      const payload = appErr ? appErr.toEnvelope() : { ok: false, code: 'SERVER_INTERNAL', message: '服务端内部错误' }
      const status = appErr ? appErr.status : 500
      if (!appErr) log.error('unhandled_error', { message: err && err.message, stack: err && err.stack })

      // ⚠️ 错误响应同样签名（若已知会话）。否则客户端无法区分
      //    "服务端说余额不足" 与 "中间人伪造余额不足"。
      return sendSigned(res, {
        session: ctx.session, requestNonce: ctx.requestNonce,
        status, payload, pathWithQuery, nowMs, log,
      })
    }
  })

  return {
    server,
    db,
    config,
    log,
    close: () => {
      // ⚠️ 不用空 catch。关闭失败要留痕——否则端口占用等问题会被静默吞掉，
      //    表现为"重启后端口还被占着"却查不到原因。
      try {
        server.close()
      } catch (e) {
        log.warn('server_close_failed', { message: e && e.message })
      }
      close()
    },
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, () => {
        const addr = server.address()
        log.info('listening', { host: addr.address, port: addr.port, protocol_version: config.protocolVersion })
        resolve(addr)
      })
    }),
  }
}

// ── 直接运行时启动 ──────────────────────────────────────────
if (require.main === module) {
  let instance
  try {
    instance = createServer({ verbose: true })
  } catch (e) {
    console.error('[fatal] 启动失败：' + e.message)
    process.exit(1)
  }

  instance.listen().then(() => {
    console.log(`[dy-license] 已就绪 → http://${instance.config.host}:${instance.config.port}/healthz`)
    if (instance.config.host === '127.0.0.1') {
      console.log('[dy-license] 仅绑定回环。对外请经反向代理 + HTTPS（见部署指南 §6）')
    }
  }).catch((e) => {
    console.error('[fatal] 监听失败：' + e.message)
    process.exit(1)
  })

  const timer = setInterval(() => {
    try {
      const r = M.cleanupEphemeral(instance.db, Date.now())
      if (r.nonces_deleted || r.seq_deleted) instance.log.info('ephemeral_cleanup', r)
    } catch (e) {
      instance.log.warn('cleanup_failed', { message: e.message })
    }
  }, 3600000)
  timer.unref()

  const shutdown = (sig) => {
    console.log(`\n[dy-license] 收到 ${sig}，正在停止…`)
    clearInterval(timer)
    instance.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

module.exports = { createServer, buildRouter, API, withToken, sendSigned }
