'use strict'

// license-server/crypto/sign.js
//
// HMAC 签名与验签（protocol.md §5）。
//
// 用途：
//   · 客户端请求签名（防篡改、防重放）
//   · 服务端响应签名（防中间人伪造"余额充足"，见红色 2 的防篡改要求）
//   · 登录响应 login_proof（用密码派生密钥，解决"密钥就在响应里无法自证"）
//
// ⚠️ 签名串必须用 shared/lib/stable-stringify.js 生成。用 JSON.stringify
//    会因 key 顺序不同导致两端算出的签名不一致。

const crypto = require('node:crypto')
const { stableStringify } = require('../../shared/lib/stable-stringify')
const { AppError } = require('../../shared/lib/errors')

const SIGN_ALGO = 'sha256'
/** 签名时间戳容忍窗口（protocol.md §1.4）：±5 分钟 */
const SIGN_TS_TOLERANCE_MS = 5 * 60 * 1000

/** 生成 32 字节随机密钥（hex 表示）。 */
function generateSignKey() {
  return crypto.randomBytes(32).toString('hex')
}

/** 生成会话令牌（32 字节随机 hex）。服务端只存其 sha256。 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

/** sha256 hex。用于存 token / sign_key / 卡密的哈希。 */
function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * HMAC 签名。
 * @param {string} key 签名密钥
 * @param {string} payload 已序列化的字符串（通常来自 stableStringify）
 */
function hmacHex(key, payload) {
  return crypto.createHmac(SIGN_ALGO, key).update(payload, 'utf8').digest('hex')
}

/**
 * 对一个对象签名。内部用 stableStringify，保证两端一致。
 */
function signObject(key, obj) {
  return hmacHex(key, stableStringify(obj))
}

/** 定时安全比较两个 hex 签名。长度不同直接 false。 */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ba.length === 0 || ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/**
 * 校验请求签名。
 *
 * 签名串构成（protocol.md §5.1）：
 *   method + "\n" + path + "\n" + stableStringify(body) + "\n" + ts + "\n" + nonce + "\n" + seq
 *
 * ⚠️ 时间戳容忍是必须的：客户端与本机时钟可能有偏差，而签名含 ts。
 *    容忍窗口取 ±5 分钟，超出即 SERVER 侧判失败。
 *
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function verifyRequestSignature({
  signKey, method, path: reqPath, body, ts, nonce, seq, signature, nowMs,
}) {
  const now = nowMs === undefined ? Date.now() : nowMs

  if (!signature || !ts || !nonce) {
    return { ok: false, code: 'AUTH_SIGN_MISSING', message: '缺少签名、时间戳或 nonce' }
  }

  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum)) {
    return { ok: false, code: 'AUTH_SIGN_INVALID', message: '时间戳格式非法' }
  }
  if (Math.abs(now - tsNum) > SIGN_TS_TOLERANCE_MS) {
    return {
      ok: false,
      code: 'AUTH_SIGN_EXPIRED',
      message: '请求时间戳超出容忍窗口，请检查本机时钟',
      detail: { skew_ms: now - tsNum, tolerance_ms: SIGN_TS_TOLERANCE_MS },
    }
  }

  const payload = buildRequestSignString({ method, path: reqPath, body, ts, nonce, seq })
  const expected = hmacHex(signKey, payload)

  if (!safeEqualHex(expected, signature)) {
    return { ok: false, code: 'AUTH_SIGN_INVALID', message: '签名校验失败' }
  }
  return { ok: true }
}

/** 按契约规定的顺序拼签名串。⚠️ 顺序变了就等于改了协议。 */
function buildRequestSignString({ method, path: reqPath, body, ts, nonce, seq }) {
  return [
    String(method || '').toUpperCase(),
    String(reqPath || ''),
    stableStringify(body === undefined ? {} : body),
    String(ts),
    String(nonce),
    String(seq === undefined ? '' : seq),
  ].join('\n')
}

/** 对响应体签名，附加到响应中供客户端验签。 */
function signResponse(signKey, body, nowMs) {
  const serverTimeMs = nowMs === undefined ? Date.now() : nowMs
  const m = { ...body, server_time_ms: serverTimeMs }
  const proof = hmacHex(signKey, stableStringify(m))
  return { ...m, sign: proof }
}

/** 客户端侧：校验服务端响应签名。失败即视为网络不安全（fail-closed）。 */
function verifyResponseSignature(signKey, body) {
  if (!body || typeof body !== 'object') {
    throw new AppError('AUTH_SIGN_INVALID', '响应不是对象，无法验签')
  }
  const { sign, ...rest } = body
  if (!sign) throw new AppError('AUTH_SIGN_MISSING', '服务端响应缺少签名')
  const expected = hmacHex(signKey, stableStringify(rest))
  if (!safeEqualHex(expected, sign)) {
    throw new AppError('AUTH_SIGN_INVALID', '服务端响应签名校验失败，连接可能被篡改')
  }
  return rest
}

/**
 * 登录响应自证（login_proof）。
 *
 * ⚠️ 解决的问题：登录响应本身携带 sign_key，无法用 sign_key 给自己签名
 *    （鸡生蛋）。因此改用**密码派生密钥**给响应签名，客户端用同一个
 *    派生方式复算即可确认响应未被篡改。
 *
 * 派生：PBKDF2(password, 'dsh-login|' + account + '|' + device_id, 100000, 32)
 */
function deriveLoginKey(password, account, deviceId) {
  return crypto
    .pbkdf2Sync(password, `dsh-login|${account}|${deviceId}`, 100000, 32, 'sha256')
    .toString('hex')
}

/** 用登录派生密钥为响应体生成 login_proof。覆盖范围排除 login_proof 自身。 */
function buildLoginProof(password, account, deviceId, responseBody) {
  const key = deriveLoginKey(password, account, deviceId)
  const { login_proof, ...rest } = responseBody
  return hmacHex(key, sha256Hex(stableStringify(rest)))
}

/** 客户端侧：校验 login_proof。 */
function verifyLoginProof(password, account, deviceId, responseBody) {
  if (!responseBody || !responseBody.login_proof) {
    throw new AppError('AUTH_SIGN_MISSING', '登录响应缺少 login_proof')
  }
  const expected = buildLoginProof(password, account, deviceId, responseBody)
  if (!safeEqualHex(expected, responseBody.login_proof)) {
    throw new AppError('AUTH_SIGN_INVALID', '登录响应被篡改，已拒绝登录')
  }
  return true
}

module.exports = {
  SIGN_ALGO,
  SIGN_TS_TOLERANCE_MS,
  generateSignKey,
  generateToken,
  sha256Hex,
  hmacHex,
  signObject,
  safeEqualHex,
  buildRequestSignString,
  verifyRequestSignature,
  signResponse,
  verifyResponseSignature,
  deriveLoginKey,
  buildLoginProof,
  verifyLoginProof,
}
