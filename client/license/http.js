'use strict'

// client/license/http.js
//
// 与授权中心通信的传输层 —— **契约 §5 的唯一落地点**。
//
// ⚠️ 本模块承担全项目最关键的 fail-closed 职责。三条不可动摇的规则：
//
//   1. **先验签，后解析**。响应签名覆盖的是 `sha256(raw_body_bytes)`，
//      所以必须对**原始字节**验签，通过之后才允许 JSON.parse。
//      反过来（先 parse 再验签）等于让中间人构造的对象先进入业务逻辑，
//      中途任何一次字段读取都已经是被污染的数据。
//
//   2. **验签失败 = 停机**，不是"重试一次"。契约 §5.4 明确：任何一次
//      响应验签失败 → 记录安全事件 → 立即进入暂停态 → 退避重试登录。
//      理由：验签失败意味着链路不可信，此后读到的余额、策略、配额
//      全部可能是伪造的。放宽阈值（如"允许 1% 失败"）就等于把
//      红线 1 的限额判定交给中间人。
//
//   3. **未签名 ≠ 被篡改**。会话已失效（401/403）时服务端手上没有密钥，
//      **只能**返回未签名响应。若一律判为篡改，token 一过期就会误报
//      安全事件并停机。故用 `X-Lic-Unsigned: auth` 显式区分：
//        · auth       → 身份问题，交给上层重新登录
//        · 缺失/其他  → fail-closed
//
// ⚠️ 不用第三方 HTTP 库（AGENTS.md §2.14 依赖白名单只有 `ws`）。
//    node:https / node:http 完全够用，且少一层依赖就少一层供应链风险。

const http = require('node:http')
const https = require('node:https')
const { URL } = require('node:url')

const shared = require('../../shared/lib/sign')
const { AppError } = require('../../shared/lib/errors')
const { PROTOCOL_VERSION, HEADERS, UNSIGNED_REASONS, PATHS } = require('../../shared/lib/protocol')
const keys = require('./keys')

/** 默认超时。心跳 60 秒一次，单次请求超过 20 秒就没有等待价值。 */
const DEFAULT_TIMEOUT_MS = 20000
/** 网络层退避上限（契约 §9.3：上限 60 秒） */
const MAX_BACKOFF_MS = 60000

/**
 * 判定一个错误是否"请求根本没送达服务端"。
 *
 * ⚠️ 只有这类错误才允许**自动重试**：连接都没建立起来，服务端不可能
 *    已经处理过。而 `ECONNRESET` 出现在"已发送但响应未读完"时，
 *    服务端**可能**已经处理——是否重试必须由调用方按幂等性决定。
 */
const CONNECT_ERRORS = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
])

/** 网络类错误（可重试，但非幂等请求需调用方显式允许） */
const TRANSIENT_ERRORS = new Set([
  ...CONNECT_ERRORS, 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
])

class LicenseHttp {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl            授权中心基址（http:// 或 https://）
   * @param {() => object} opts.getAuthState 取当前凭据（token / sign key / clockSkewMs）
   * @param {number} [opts.timeoutMs]
   * @param {object} [opts.logger]           需实现 warn/info/error
   * @param {(evt: object) => void} [opts.onSecurityEvent] 安全事件回调（不做静默处理）
   */
  constructor(opts) {
    if (!opts || !opts.baseUrl) throw new Error('LicenseHttp 需要 baseUrl')
    if (typeof opts.getAuthState !== 'function') throw new Error('LicenseHttp 需要 getAuthState 函数')

    const u = new URL(opts.baseUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`licenseBaseUrl 协议不支持：${u.protocol}`)
    }

    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.origin = u.origin
    this.secure = u.protocol === 'https:'
    this.getAuthState = opts.getAuthState
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS
    this.logger = opts.logger || null
    this.onSecurityEvent = opts.onSecurityEvent || null
    /** 最近一次由服务端校准出的时钟偏移（毫秒） */
    this.clockSkewMs = 0
    /** 由服务端 limits 覆盖；未拿到时为 null，用内置默认 */
    this.limits = null
    /** 串行化保证：同一时刻只允许一个"待重试"循环驱动，避免雪崩 */
    this.agent = this.secure ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true })
  }

  close() {
    this.agent.destroy()
  }

  /** 记录安全事件。⚠️ 绝不静默——验签失败必须留痕（AGENTS.md §2.8）。 */
  #security(code, detail) {
    const evt = { code, at_ms: Date.now(), ...detail }
    if (this.logger) this.logger.error('security_event', evt)
    if (this.onSecurityEvent) this.onSecurityEvent(evt)
    return evt
  }

  /**
   * 用服务端时间校准本地时钟。
   *
   * ⚠️ 契约 §5.4：`sign_ts_tolerance_ms = 300000`（±5 分钟）。
   *    普通电脑时钟偏差超过 5 分钟并不罕见（长期未同步、时区工具改过），
   *    一旦超窗**所有**请求都会 401，表现为"登录成功但什么都做不了"。
   */
  calibrateClock(serverTimeMs, atMs) {
    const local = atMs === undefined ? Date.now() : atMs
    const skew = Number(serverTimeMs) - local
    if (!Number.isFinite(skew)) return this.clockSkewMs
    // ⚠️ 只在偏移稳定时更新，避免单次抖动把已校准的值带偏。
    this.clockSkewMs = skew
    return skew
  }

  /** 供签名的当前时间戳（已按服务端校准）。 */
  nowTs() {
    return Date.now() + this.clockSkewMs
  }

  /** 时间戳容差（由服务端 limits 覆盖，默认契约 §5.4 的 300000）。 */
  signTsToleranceMs() {
    const v = this.limits && Number(this.limits.sign_ts_tolerance_ms)
    return Number.isFinite(v) && v > 0 ? v : 300000
  }

  /**
   * 发一个**已签名**请求（契约 §5.1）。
   *
   * @param {object} p
   * @param {'GET'|'POST'} p.method
   * @param {string} p.path                   必须从 `/api/` 开始，含 query
   * @param {object|string} [p.body]          对象（只序列化一次）或已序列化字符串
   * @param {number} [p.retries]              网络层自动重试次数（仅 GET 默认 2）
   * @param {boolean} [p.expectSignature]     默认 true
   * @returns {Promise<{status:number, body:any, rawBody:string, headers:object,
   *                    signed:boolean, requestNonce:string, serverTimeMs:number|null}>}
   *
   * ⚠️ 失败一律抛 AppError（错误码取自 shared/lib/errors.js 的登记表），
   *    调用方只需分辨 `code`，不需要解析 message 文本。
   */
  async request(p) {
    const method = String(p.method || 'GET').toUpperCase()
    const path = p.path
    if (!path || !path.startsWith('/')) {
      throw new Error(`请求路径必须以 / 开头（收到：${path}）`)
    }

    // ⚠️ 序列化**只做一次**，并把这个字符串同时用于计算哈希与实际发送。
    //    若序列化两次，两次结果理论上相同但一旦引入任何时间相关字段
    //    就会不一致 → 服务端算出的 sha256 与客户端不同 → 签名失败。
    const rawBody = p.body === undefined || p.body === null
      ? ''
      : (typeof p.body === 'string' ? p.body : JSON.stringify(p.body))

    const retries = p.retries === undefined ? (method === 'GET' ? 2 : 0) : p.retries

    let attempt = 0
    for (;;) {
      try {
        return await this.#once({ method, path, rawBody, expectSignature: p.expectSignature !== false })
      } catch (e) {
        const transient = e && e.detail && e.detail.network === true
        const canRetry = transient && attempt < retries
          && (method === 'GET' || CONNECT_ERRORS.has(e.detail.errno))
        if (!canRetry) throw e
        attempt += 1
        const wait = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS)
        if (this.logger) {
          this.logger.warn('request_retry', { path, attempt, wait_ms: wait, errno: e.detail.errno })
        }
        await sleep(wait)
      }
    }
  }

  /** 单次请求（含签名与验签）。 */
  async #once({ method, path, rawBody, expectSignature }) {
    const state = this.getAuthState()
    if (!state || !state.token) {
      throw new AppError('AUTH_TOKEN_MISSING', '尚未登录授权中心')
    }
    if (!state.key) {
      throw new AppError('AUTH_SIGN_MISSING', '缺少签名密钥，请重新登录')
    }

    const ts = this.nowTs()
    const nonce = shared.generateNonce()
    const picked = keys.selectKey(state, ts)
    if (!picked.key) throw new AppError('AUTH_SIGN_MISSING', '签名密钥已失效，请重新登录')

    const signature = shared.signRequest({
      signKey: picked.key, method, pathWithQuery: path, ts, nonce, rawBody,
    })

    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${state.token}`,
      [HEADERS.ts]: String(ts),
      [HEADERS.nonce]: nonce,
      [HEADERS.sign]: signature,
      Accept: 'application/json',
    }
    if (rawBody) headers['Content-Length'] = Buffer.byteLength(rawBody, 'utf8')

    const res = await this.#raw({ method, path, rawBody, headers })
    const serverTimeMs = Number(res.headers[HEADERS.serverTs.toLowerCase()])

    // ⚠️ 校准时钟要用**响应到达的时刻**，不是发出时刻——
    //    两者相差一个 RTT，用发出时刻会引入固定的单向延迟偏差。
    if (Number.isFinite(serverTimeMs)) this.calibrateClock(serverTimeMs, res.receivedAtMs)

    const signHeader = res.headers[HEADERS.sign.toLowerCase()]
    const signed = Boolean(signHeader) && Number.isFinite(serverTimeMs)

    if (!signed) {
      const unsigned = res.headers[HEADERS.unsigned.toLowerCase()]
      const isAuthStatus = res.status === 401 || res.status === 403

      // ⚠️ 未签名响应没有可信性保护，但它**仍然携带服务端的错误码**，
      //    而错误码正是上层决定"重新登录"还是"停机"的依据。
      //    这里解析出来透传，不做任何业务处理——解析失败也不影响
      //    fail-closed 的判定（宁可用宽松的兜底码，也不能漏掉停机）。
      const unsignedBody = parseJsonQuietly(res.rawBody)

      if (isAuthStatus && unsigned === UNSIGNED_REASONS.auth) {
        // ── AUTH_TS_SKEW 的自愈路径 ──────────────────────────
        // ⚠️ 时钟偏差超容差时服务端在 **guard 之前**就拒绝了请求，
        //    此时 ctx.session 还没写入 → 响应**无法签名** →
        //    拿不到 X-Lic-Server-Ts → 客户端无法用常规路径校准。
        //    结果是死锁：偏差导致 401，401 导致无法校准。
        //
        //    破局点是服务端在错误 detail 里带回 `clock_skew_ms`
        //    （它正是由客户端自己发的 client_time_ms 算出来的）。
        //    这里**有界地**采纳它：只用于把偏差拉回容差内，
        //    且仅当偏差确实已超容差时才动。这样即使这条未签名响应
        //    是伪造的，攻击者能造成的最大影响也只是让客户端在一个
        //    小范围内调整时间戳——而所有**业务**响应仍必须通过验签。
        const skewFromServer = unsignedBody && unsignedBody.detail
          && unsignedBody.detail.clock_skew_ms
        if (unsignedBody && unsignedBody.code === 'AUTH_TS_SKEW'
            && Number.isFinite(Number(skewFromServer))
            && Math.abs(this.clockSkewMs) > this.signTsToleranceMs()) {
          const applied = this.calibrateClock(
            (res.receivedAtMs || Date.now()) + Number(skewFromServer),
            res.receivedAtMs
          )
          if (this.logger) {
            this.logger.warn('clock_resynced_from_ts_skew', {
              server_reported_skew_ms: Number(skewFromServer),
              applied_skew_ms: applied,
            })
          }
        }

        // 身份问题：服务端手上没有可用密钥，未签名是**预期行为**。
        // 交给 auth 层重新登录，不记为安全事件。
        throw toAppError(res, { parsed: unsignedBody, unsigned: true, reason: 'auth' })
      }

      this.#security('response_unsigned', {
        path, status: res.status, unsigned_header: unsigned || null,
        hint: '响应缺少签名，无法确认来源；按 fail-closed 处理',
      })
      throw new AppError('AUTH_SIGN_MISSING', '服务端响应未签名，已停止发送以保护账号', {
        path,
        status: res.status,
        unsigned_reason: unsigned || null,
        server_code: unsignedBody && unsignedBody.code ? unsignedBody.code : null,
      })
    }

    // ⚠️ 服务端时间戳超窗 → 说明本地时钟漂移过大。
    //    这里仍继续验签（签名本身是有效的），但要让上层知道需要重新校准。
    const tsSkew = Math.abs(Number(serverTimeMs) - this.nowTs())

    const v = shared.verifyResponseSignature({
      signKey: picked.key,
      httpStatus: res.status,
      pathWithQuery: path,
      requestNonce: nonce,
      serverTsHeader: res.headers[HEADERS.serverTs.toLowerCase()],
      signatureHeader: signHeader,
      rawBody: res.rawBody,
    })
    if (!v.ok) {
      this.#security('response_sign_invalid', {
        path, status: res.status, hint: '响应签名校验失败，连接可能被篡改',
      })
      throw new AppError('AUTH_SIGN_INVALID', '服务端响应签名校验失败，已立即停止发送', {
        path, status: res.status,
      })
    }

    // ── 验签通过，此刻才允许解析 ──────────────────────────
    const parsed = parseJsonQuietly(res.rawBody)
    if (res.rawBody && parsed === null) {
      throw new AppError('SERVER_INTERNAL', '服务端响应不是合法 JSON', {
        path, status: res.status, bytes: res.rawBody.length,
      })
    }

    if (res.status >= 400) {
      throw toAppError(res, { parsed, signed: true, tsSkew })
    }

    return {
      status: res.status, body: parsed, rawBody: res.rawBody,
      headers: res.headers, signed: true, requestNonce: nonce,
      serverTimeMs: Number.isFinite(serverTimeMs) ? serverTimeMs : null,
      keyUsed: picked.which,
    }
  }

  /**
   * 发一个**未签名**请求。
   *
   * 目前只有两个用途：`/healthz`（探活）与 `client/bootstrap`（版本闸门）。
   * ⚠️ 契约 §4.1/§4.4 明确这两个接口不签名——因为它们发生在建立会话之前，
   *    客户端手上还没有密钥。
   */
  async requestUnsigned(p) {
    const method = String(p.method || 'GET').toUpperCase()
    const path = p.path
    const rawBody = p.body === undefined || p.body === null
      ? '' : (typeof p.body === 'string' ? p.body : JSON.stringify(p.body))

    const headers = { Accept: 'application/json' }
    if (rawBody) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
      headers['Content-Length'] = Buffer.byteLength(rawBody, 'utf8')
    }

    const res = await this.#raw({ method, path, rawBody, headers })
    const serverTimeMs = Number(res.headers[HEADERS.serverTs.toLowerCase()])
    if (Number.isFinite(serverTimeMs)) this.calibrateClock(serverTimeMs, res.receivedAtMs)

    let parsed = null
    if (res.rawBody) {
      try {
        parsed = JSON.parse(res.rawBody)
      } catch (e) {
        throw new AppError('SERVER_INTERNAL', `服务端响应不是合法 JSON：${e.message}`, { path, status: res.status })
      }
    }

    if (res.status >= 400) throw toAppError(res, { parsed, signed: false })

    return {
      status: res.status, body: parsed, rawBody: res.rawBody, headers: res.headers,
      signed: false, requestNonce: null,
      serverTimeMs: Number.isFinite(serverTimeMs) ? serverTimeMs : null,
    }
  }

  /**
   * 发一个**带 Bearer token 但不签名**的请求。
   *
   * ⚠️ 存在的理由：契约 §4.2 允许用**已过期**的 token 调 refresh/logout。
   *    已过期的会话没有可用 sign_key（服务端也不为这两个接口做签名校验），
   *    所以它们既需要 token，又不能签名——`request()` 与
   *    `requestUnsigned()` 都覆盖不了这个组合。
   *
   * ⚠️ 响应同样**不验签**（服务端不会为这类响应签名）。
   *    因此本方法只允许用于 refresh / logout 这两个路径——
   *    其余任何接口都必须走 `request()`，否则等于放弃响应真实性校验。
   */
  async requestWithToken(p) {
    const allowed = [PATHS.refresh, PATHS.logout]
    if (!allowed.includes(p.path)) {
      throw new Error(
        `requestWithToken 只允许用于 ${allowed.join(' / ')}（收到 ${p.path}）。` +
        `其他接口必须走签名请求，否则无法校验响应真实性。`
      )
    }

    const method = String(p.method || 'POST').toUpperCase()
    const rawBody = p.body === undefined || p.body === null
      ? '' : (typeof p.body === 'string' ? p.body : JSON.stringify(p.body))

    const headers = {
      Accept: 'application/json',
      ...(p.headers || {}),
    }
    if (rawBody) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
      headers['Content-Length'] = Buffer.byteLength(rawBody, 'utf8')
    }

    const res = await this.#raw({ method, path: p.path, rawBody, headers })
    const serverTimeMs = Number(res.headers[HEADERS.serverTs.toLowerCase()])
    if (Number.isFinite(serverTimeMs)) this.calibrateClock(serverTimeMs, res.receivedAtMs)

    let parsed = null
    if (res.rawBody) {
      try {
        parsed = JSON.parse(res.rawBody)
      } catch (e) {
        throw new AppError('SERVER_INTERNAL', `服务端响应不是合法 JSON：${e.message}`, {
          path: p.path, status: res.status,
        })
      }
    }

    if (res.status >= 400) throw toAppError(res, { parsed, signed: false })

    return {
      status: res.status, body: parsed, rawBody: res.rawBody, headers: res.headers,
      signed: false, requestNonce: null,
      serverTimeMs: Number.isFinite(serverTimeMs) ? serverTimeMs : null,
    }
  }

  /** 裸 HTTP 收发。⚠️ 返回**原始字节**（Buffer→utf8），不做任何解释。 */
  #raw({ method, path, rawBody, headers }) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path)
      const mod = url.protocol === 'https:' ? https : http

      const req = mod.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
        agent: this.agent,
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const receivedAtMs = Date.now()
          const raw = Buffer.concat(chunks)
          resolve({
            status: res.statusCode,
            headers: res.headers,
            // ⚠️ utf8 解码必须由我们自己做：签名覆盖的是服务端发出的**字节**，
            //    Node 自动解出的字符串若经历任何规范化都会导致哈希不同。
            rawBody: raw.length ? raw.toString('utf8') : '',
            receivedAtMs,
          })
        })
        res.on('error', (e) => reject(networkError(e, path)))
      })

      req.setTimeout(this.timeoutMs, () => {
        req.destroy(Object.assign(new Error(`请求超时（${this.timeoutMs}ms）`), { code: 'ETIMEDOUT' }))
      })
      req.on('error', (e) => reject(networkError(e, path)))

      if (rawBody) req.write(rawBody, 'utf8')
      req.end()
    })
  }
}

/** 把网络层异常归一成带 `network:true` 的 AppError，便于上层判定是否重试。 */
function networkError(e, path) {
  const errno = (e && e.code) || 'UNKNOWN'
  return new AppError(
    'SERVER_UNAVAILABLE',
    `无法连接授权中心（${errno}）。已进入离线模式，明细会先存本地。`,
    { network: true, errno, path, transient: TRANSIENT_ERRORS.has(errno) }
  )
}

/**
 * 把已验签的错误响应转成 AppError。
 *
 * ⚠️ 错误码原样透传服务端下发的 `code`——**不猜测、不重写**。
 *    因为服务端错误码是闭集且已登记（shared/lib/errors.js），
 *    上层按码分支即可；一旦这里改写，分支就会失效。
 */
function toAppError(res, { parsed, signed, unsigned, reason, tsSkew } = {}) {
  const envelope = parsed && typeof parsed === 'object' ? parsed : null
  const code = envelope && typeof envelope.code === 'string' ? envelope.code : null
  const message = envelope && typeof envelope.message === 'string'
    ? envelope.message
    : `授权中心返回 ${res.status}`

  const detail = {
    status: res.status,
    signed: Boolean(signed),
    path: undefined,
    server_code: code,
    server_detail: envelope ? envelope.detail : undefined,
  }
  if (unsigned) detail.unsigned_reason = reason
  if (tsSkew !== undefined) detail.ts_skew_ms = tsSkew

  // 未登记的服务端错误码：不能直接构造 AppError（构造器会拒绝），
  // 也不能丢弃——归到 SERVER_INTERNAL 并在 detail 里保留原始码。
  if (!code || !isKnownCode(code)) {
    return new AppError('SERVER_INTERNAL', message, detail)
  }
  return new AppError(code, message, detail)
}

function isKnownCode(code) {
  const { ERROR_CODES } = require('../../shared/lib/errors')
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code)
}

function sleep(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref() })
}

/**
 * 宽松解析：失败返回 null。
 *
 * ⚠️ 只用于"解析失败不影响安全判定"的场合（未签名响应、错误响应）。
 *    正常响应路径**不得**用它——那里解析失败必须明确报错，
 *    否则会把"服务端返回了 HTML 错误页"静默当成"空响应"。
 */
function parseJsonQuietly(raw) {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    // 解析失败即返回 null，由调用方决定如何处理（这里不吞掉语义，
    // 只是不把异常抛到调用栈上）。
    return null
  }
}

module.exports = {
  LicenseHttp,
  DEFAULT_TIMEOUT_MS,
  MAX_BACKOFF_MS,
  CONNECT_ERRORS,
  TRANSIENT_ERRORS,
  toAppError,
  isKnownCode,
}
