'use strict'

// license-server/crypto/sign.js
//
// 服务端签名适配层。
//
// ⚠️ **签名原语全部来自 shared/lib/sign.js**，本文件只做两件事：
//    1. 再导出（保持既有 require 路径不变）
//    2. 提供服务端独有的密钥/令牌生成
//
// 为什么不在本文件重新实现：
//    签名要求两端算出的字符串**逐字节相同**。两份实现迟早漂移，
//    而漂移的后果是校验失败 → fail-closed 停机 → 排查成本极高。
//    契约 §5.1/§5.2 的拼串规则只应有一份实现。

const crypto = require('node:crypto')
const shared = require('../../shared/lib/sign')
const { AppError } = require('../../shared/lib/errors')

/** 生成 32 字节签名密钥（hex）。 */
function generateSignKey() {
  return crypto.randomBytes(32).toString('hex')
}

/** 生成会话令牌（32 字节随机 hex）。服务端只存其 sha256。 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * 服务端侧：对响应签名并附加到响应头。
 *
 * ⚠️ 返回的是**响应头**，不是 body 字段。契约 §5.2 规定
 *    签名字段走 `X-Lic-Server-Ts` / `X-Lic-Sign`。
 *    放 body 里会导致"签名覆盖自己"的自指问题。
 */
function buildResponseHeaders(signKey, httpStatus, pathWithQuery, requestNonce, rawBody, serverTimeMs) {
  const sign = shared.signResponseRaw({
    signKey, httpStatus, pathWithQuery, requestNonce, serverTimeMs, rawBody,
  })
  return {
    'X-Lic-Server-Ts': String(serverTimeMs),
    'X-Lic-Sign': sign,
  }
}

/**
 * 服务端侧：校验请求签名。失败时抛 AppError（便于统一错误处理）。
 */
function assertRequestSignature(params) {
  const r = shared.verifyRequestSignature(params)
  if (!r.ok) throw new AppError(r.code, r.message, r.detail)
  return r
}

module.exports = {
  // ── 共享原语（再导出）────────────────────────────────────
  SIGN_ALGO: shared.SIGN_ALGO,
  SIGN_TS_TOLERANCE_MS: shared.SIGN_TS_TOLERANCE_MS,
  NONCE_MIN_LEN: shared.NONCE_MIN_LEN,
  NONCE_MAX_LEN: shared.NONCE_MAX_LEN,
  sha256Hex: shared.sha256Hex,
  hmacHex: shared.hmacHex,
  safeEqualHex: shared.safeEqualHex,
  randomHex: shared.randomHex,
  buildRequestSignString: shared.buildRequestSignString,
  signRequest: shared.signRequest,
  verifyRequestSignature: shared.verifyRequestSignature,
  buildResponseSignString: shared.buildResponseSignString,
  signResponseRaw: shared.signResponseRaw,
  // ⚠️ 服务端/测试沿用"失败即抛"的旧语义；客户端请直接用
  //    shared/lib/sign.js 的 result 形式（fail-closed 由调用方决定）。
  verifyResponseSignature: (p) => {
    const r = shared.verifyResponseSignature(p)
    if (!r.ok) throw new AppError(r.code, r.message)
    return true
  },
  deriveLoginKey: shared.deriveLoginKey,
  buildLoginProof: shared.buildLoginProof,
  verifyLoginProof: (password, account, deviceId, responseBody) => {
    // ⚠️ 服务端测试用：把 result 形式转成"失败即抛"的旧语义，
    //    保持既有调用点不变。客户端请直接用 shared 的 result 形式。
    const r = shared.verifyLoginProof(password, account, deviceId, responseBody)
    if (!r.ok) throw new AppError(r.code, r.message)
    return true
  },
  stableJson: shared.stableJson,
  generateNonce: shared.generateNonce,

  // ── 服务端独有 ───────────────────────────────────────────
  generateSignKey,
  generateToken,
  buildResponseHeaders,
  assertRequestSignature,
}
