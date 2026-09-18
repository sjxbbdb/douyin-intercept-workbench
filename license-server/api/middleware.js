'use strict'

// license-server/api/middleware.js
//
// 鉴权与防重放中间件。
//
// 每个受保护接口过三道关：
//   1. Bearer token → 找到会话（未过期、未吊销）
//   2. HMAC 签名校验（按契约 §5.1，字段走**请求头**）
//   3. nonce 去重 + 通道内 seq 单调（防重放）
//
// ⚠️ 三道关缺一不可：
//   · 只有 token 没有签名 → 中间人可篡改请求体（如把 daily_max 改成 999）
//   · 只有签名没有 nonce → 抓包可重放（如重放"已充值"的请求）
//   · 只有 nonce 没有 seq → 无法发现乱序与回退
//
// ⚠️ 签名字段放在**请求头**而非 body，这是契约 §5.1 的规定：
//    · GET 请求没有 body，放 body 就无法携带
//    · 签名若覆盖自己所在的字段会形成自指
//   头名：X-Lic-Ts / X-Lic-Nonce / X-Lic-Sign

const { AppError } = require('../../shared/lib/errors')
const { sha256Hex, verifyRequestSignature, buildRequestSignString } = require('../crypto/sign')

/** nonce 保留时长（protocol.md §1.4） */
const NONCE_TTL_MS = 600000

/** 序号通道。各通道独立计数，避免心跳挤掉上报的序号。 */
const SEQ_CHANNELS = Object.freeze(['heartbeat', 'usage', 'sends', 'config_audit'])

const HEADER_TS = 'x-lic-ts'
const HEADER_NONCE = 'x-lic-nonce'
const HEADER_SIGN = 'x-lic-sign'

/** 从 Authorization 头取 token。 */
function extractToken(req) {
  const h = req.headers.authorization || ''
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  return m ? m[1].trim() : null
}

/** 从请求头取签名字段。 */
function extractSignatureHeaders(req) {
  return {
    ts: req.headers[HEADER_TS],
    nonce: req.headers[HEADER_NONCE],
    signature: req.headers[HEADER_SIGN],
  }
}

/** 按 token 找会话。 */
function loadSession(db, token, nowMs) {
  const row = db.prepare(`
    SELECT s.*, a.account, a.display_name, a.status AS account_status,
           a.plan_expires_ms, a.first_login_ms
    FROM device_session s
    JOIN account a ON a.account_id = s.account_id
    WHERE s.token_hash = ?
  `).get(sha256Hex(token))
  if (!row) return null

  if (row.revoked_at_ms) throw new AppError('AUTH_TOKEN_REVOKED', '该会话已被吊销，请重新登录')
  if (Number(row.expires_at_ms) <= nowMs) throw new AppError('AUTH_TOKEN_EXPIRED', '会话已过期，请重新登录')
  if (row.account_status === 'disabled') throw new AppError('AUTH_ACCOUNT_DISABLED', '账号已停用，请联系客服')
  if (row.account_status === 'expired') throw new AppError('AUTH_ACCOUNT_EXPIRED', '账号或套餐已到期，请联系客服续费')
  return row
}

/**
 * 校验 nonce 唯一性与 seq 单调性，并推进计数器。
 *
 * ⚠️ 读-判-写必须在**同一个事务**里完成，否则并发请求会互相放行。
 * ⚠️ 重复 nonce 判 AUTH_REPLAY 且**不消耗** seq（该请求整体无效）。
 */
function checkReplay(db, { accountId, sessionId, nonce, seq, channel, nowMs }) {
  if (!nonce || typeof nonce !== 'string') {
    throw new AppError('AUTH_SIGN_MISSING', '缺少 X-Lic-Nonce')
  }
  if (!SEQ_CHANNELS.includes(channel)) {
    throw new AppError('AUTH_INVALID_REQUEST', `未知的序号通道 ${channel}`, { allowed: SEQ_CHANNELS })
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    const dup = db.prepare('SELECT nonce FROM request_nonce WHERE nonce = ?').get(nonce)
    if (dup) throw new AppError('AUTH_REPLAY', 'nonce 已使用过，判定为重放')

    const key = `${accountId}:${sessionId}:${channel}`
    const cur = db.prepare('SELECT max_seq FROM seq_counter WHERE counter_key = ?').get(key)
    const maxSeq = cur ? Number(cur.max_seq) : 0
    const seqNum = Number(seq)
    if (!Number.isFinite(seqNum) || seqNum <= maxSeq) {
      throw new AppError('AUTH_REPLAY', '序号未递增，判定为重放或乱序', {
        channel, reported: seq, expected_above: maxSeq,
      })
    }

    db.prepare('INSERT INTO request_nonce (nonce, account_id, seen_at_ms) VALUES (?,?,?)')
      .run(nonce, accountId, nowMs)
    db.prepare(`
      INSERT INTO seq_counter (counter_key, account_id, session_id, channel, max_seq, updated_at_ms)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(counter_key) DO UPDATE SET max_seq = excluded.max_seq,
                                            updated_at_ms = excluded.updated_at_ms
    `).run(key, accountId, sessionId, channel, seqNum, nowMs)

    db.exec('COMMIT')
    return seqNum
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/**
 * 构造受保护 handler 的包装器。
 *
 * ⚠️ 要求调用方**先**把 body 解析好放进 `ctx.body` / `ctx.rawBody`。
 *    中间件不自己读流——否则会与路由 handler 争抢 req 的 data 事件。
 */
function guard(channel, handler) {
  return async (ctx) => {
    const { req, db, nowMs } = ctx

    const token = extractToken(req)
    if (!token) throw new AppError('AUTH_TOKEN_MISSING', '请求未携带 token')

    const session = loadSession(db, token, nowMs)
    if (!session) throw new AppError('AUTH_TOKEN_INVALID', 'token 无法识别，请重新登录')

    const { ts, nonce, signature } = extractSignatureHeaders(req)

    const sig = verifyRequestSignature({
      signKey: session.sign_key_plain,
      method: req.method,
      // ⚠️ 必须含 query（契约 §5.1）。用 rawUrl 而非 pathname。
      pathWithQuery: ctx.rawUrl,
      rawBody: ctx.rawBody || '',
      ts,
      nonce,
      signature,
      nowMs,
    })
    if (!sig.ok) {
      // ⚠️ AUTH_TS_SKEW 必须在 detail 里带回 `clock_skew_ms`。
      //    原因：时间戳超容差时本请求在 guard 阶段就被拒，
      //    此时 ctx.session 尚未写入 → 响应**无法签名** →
      //    客户端拿不到 X-Lic-Server-Ts，无法按常规路径校准时钟。
      //    结果是死锁：偏差 → 401 → 无法校准 → 继续 401。
      //    客户端用客户端自己发的 client_time_ms 反推即可自愈，
      //    服务端只需把这个值算出来告诉它。
      const detail = sig.code === 'AUTH_TS_SKEW'
        ? { ...(sig.detail || {}), clock_skew_ms: skewFromBody(ctx.body, nowMs) }
        : sig.detail
      throw new AppError(sig.code, sig.message, detail)
    }

    if (channel !== null) {
      checkReplay(db, {
        accountId: session.account_id,
        sessionId: session.id,
        nonce,
        seq: ctx.body ? ctx.body.seq : undefined,
        channel,
        nowMs,
      })
    }

    db.prepare('UPDATE device_session SET last_seen_ms = ? WHERE id = ?').run(nowMs, session.id)

    // ⚠️ 必须写回**原 ctx**（而不是只放进新对象）：
    //    服务端在 handler 返回后要用 requestNonce 给响应签名
    //    （契约 §5.2 的 canonical_response 含 request_nonce），
    //    若这里只传新对象，原 ctx 上永远是 null，响应签名就会用空 nonce，
    //    而客户端用自己发的 nonce 验签 → 必然失败。
    ctx.session = session
    ctx.requestNonce = nonce
    ctx.body = ctx.body || {}

    return handler(ctx)
  }
}

/** 从请求体里取客户端自报时间，算出"客户端应该加多少毫秒"。
 *
 * ⚠️ 返回的是 `服务端时间 - 客户端时间`，客户端直接把它当成 clockSkewMs 用。
 *    取不到时返回 0（客户端会因"偏差仍超容差"而不采纳）。
 */
function skewFromBody(body, nowMs) {
  if (!body || typeof body !== 'object') return 0
  const clientTime = Number(body.client_time_ms || body.wall_clock_ms)
  if (!Number.isFinite(clientTime) || clientTime <= 0) return 0
  return nowMs - clientTime
}

/** 清理过期 nonce 与旧序号计数（由定时任务调用）。 */
function cleanupEphemeral(db, nowMs) {
  const a = db.prepare('DELETE FROM request_nonce WHERE seen_at_ms < ?').run(nowMs - NONCE_TTL_MS)
  const b = db.prepare('DELETE FROM seq_counter WHERE updated_at_ms < ?').run(nowMs - 7 * 86400000)
  return { nonces_deleted: Number(a.changes || 0), seq_deleted: Number(b.changes || 0) }
}

module.exports = {
  NONCE_TTL_MS,
  SEQ_CHANNELS,
  HEADER_TS,
  HEADER_NONCE,
  HEADER_SIGN,
  extractToken,
  extractSignatureHeaders,
  loadSession,
  checkReplay,
  guard,
  cleanupEphemeral,
  buildRequestSignString,
}
