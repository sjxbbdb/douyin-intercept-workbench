'use strict'

// license-server/crypto/sign.js
//
// HMAC 签名与验签。**严格按 shared/protocol.md §5 实现**。
//
// ⚠️ 签名串的每一个字符都有契约依据，改任何一个字符都是不兼容变更。
//
// 请求签名（§5.1）：
//   canonical = METHOD + "\n" + PATH_WITH_QUERY + "\n" + ts_ms + "\n" + nonce
//               + "\n" + sha256_hex(raw_body_bytes)
//   字段走**请求头**：X-Lic-Ts / X-Lic-Nonce / X-Lic-Sign
//
// 响应签名（§5.2）：
//   canonical = "RESP" + "\n" + http_status + "\n" + PATH_WITH_QUERY + "\n"
//               + request_nonce + "\n" + server_time_ms + "\n" + sha256_hex(raw_body)
//   字段走**响应头**：X-Lic-Server-Ts / X-Lic-Sign
//
// ⚠️ 三个实现要点（我最初写错，已按契约纠正）：
//   1. **签的是原始字节的哈希，不是重新序列化的对象**。若两端各自
//      JSON.stringify，key 顺序或空格差异会让签名不一致。
//   2. **路径必须含 query**。`/credit/ledger?granularity=raw` 与
//      `/credit/ledger` 是两个不同的请求，不含 query 等于允许在参数上做手脚。
//   3. **字段走 header，不走 body**。放 body 里会导致 GET 请求无法携带
//      （GET 无 body），且签名覆盖自己所在字段会造成自指。
//
// ⚠️ 错误响应也**必须签名**（§5.2），否则客户端无法区分
//    "服务端说余额不足" 与 "中间人伪造余额不足"。

const crypto = require('node:crypto')
const { AppError } = require('../../shared/lib/errors')

const SIGN_ALGO = 'sha256'
/** 签名时间戳容忍窗口（protocol.md §1.4）：±5 分钟 */
const SIGN_TS_TOLERANCE_MS = 5 * 60 * 1000
/** nonce 长度约束。契约写 16–32 位 hex；实现放宽上界到 64，见 §附注 */
const NONCE_MIN_LEN = 16
const NONCE_MAX_LEN = 64

// ═══════════════════════════════════════════════════════════
// 基础工具
// ═══════════════════════════════════════════════════════════

function generateSignKey() {
  return crypto.randomBytes(32).toString('hex')
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function hmacHex(key, payload) {
  return crypto.createHmac(SIGN_ALGO, key).update(payload, 'utf8').digest('hex')
}

/** 定时安全比较。长度不同或非 hex 直接 false。 */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (!/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ba.length === 0 || ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

// ═══════════════════════════════════════════════════════════
// 请求签名（§5.1）
// ═══════════════════════════════════════════════════════════

/**
 * 构造请求签名串。
 *
 * @param {object} p
 * @param {string} p.method        HTTP 方法（内部转大写）
 * @param {string} p.pathWithQuery 从 `/api/` 开始，**含 query**，不重编码
 * @param {number|string} p.ts     13 位 Unix 毫秒
 * @param {string} p.nonce
 * @param {string|Buffer} p.rawBody 原始请求体字节；无 body 传空
 */
function buildRequestSignString({ method, pathWithQuery, ts, nonce, rawBody }) {
  const bodyBytes = rawBody === undefined || rawBody === null ? '' : rawBody
  return [
    String(method || '').toUpperCase(),
    String(pathWithQuery || ''),
    String(ts),
    String(nonce),
    sha256Hex(bodyBytes),
  ].join('\n')
}

/** 计算请求签名。客户端与服务端共用同一函数，避免两端实现漂移。 */
function signRequest({ signKey, method, pathWithQuery, ts, nonce, rawBody }) {
  return hmacHex(signKey, buildRequestSignString({ method, pathWithQuery, ts, nonce, rawBody }))
}

/**
 * 校验请求签名。
 *
 * @returns {{ok:true, ts:number, nonce:string} | {ok:false, code:string, message:string, detail?:object}}
 */
function verifyRequestSignature({
  signKey, method, pathWithQuery, rawBody, ts, nonce, signature, nowMs,
}) {
  const now = nowMs === undefined ? Date.now() : nowMs

  if (!signature || ts === undefined || ts === null || !nonce) {
    return { ok: false, code: 'AUTH_SIGN_MISSING', message: '缺少 X-Lic-Sign / X-Lic-Ts / X-Lic-Nonce' }
  }

  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum)) {
    return { ok: false, code: 'AUTH_SIGN_INVALID', message: 'X-Lic-Ts 不是合法数字' }
  }

  if (!/^[0-9a-f]+$/i.test(String(nonce)) ||
      String(nonce).length < NONCE_MIN_LEN || String(nonce).length > NONCE_MAX_LEN) {
    return {
      ok: false,
      code: 'AUTH_SIGN_INVALID',
      message: `X-Lic-Nonce 必须是 ${NONCE_MIN_LEN}~${NONCE_MAX_LEN} 位 hex`,
    }
  }

  if (Math.abs(now - tsNum) > SIGN_TS_TOLERANCE_MS) {
    return {
      ok: false,
      code: 'AUTH_TS_SKEW',
      message: '请求时间戳超出容忍窗口，请用 server_time_ms 校准本机时钟后重试',
      detail: { skew_ms: now - tsNum, tolerance_ms: SIGN_TS_TOLERANCE_MS },
    }
  }

  const expected = signRequest({ signKey, method, pathWithQuery, ts: tsNum, nonce, rawBody })
  if (!safeEqualHex(expected, String(signature))) {
    return { ok: false, code: 'AUTH_SIGN_INVALID', message: '签名校验失败' }
  }
  return { ok: true, ts: tsNum, nonce: String(nonce) }
}

// ═══════════════════════════════════════════════════════════
// 响应签名（§5.2）
// ═══════════════════════════════════════════════════════════

/**
 * 构造响应签名串。
 *
 * ⚠️ 含 `request_nonce`：把响应与**这一次请求**绑定，
 *    防止攻击者把旧响应重放给新请求（如重放"余额充足"）。
 */
function buildResponseSignString({ httpStatus, pathWithQuery, requestNonce, serverTimeMs, rawBody }) {
  return [
    'RESP',
    String(httpStatus),
    String(pathWithQuery || ''),
    String(requestNonce || ''),
    String(serverTimeMs),
    sha256Hex(rawBody === undefined || rawBody === null ? '' : rawBody),
  ].join('\n')
}

/** 计算响应签名。 */
function signResponseRaw({ signKey, httpStatus, pathWithQuery, requestNonce, serverTimeMs, rawBody }) {
  return hmacHex(signKey, buildResponseSignString({
    httpStatus, pathWithQuery, requestNonce, serverTimeMs, rawBody,
  }))
}

/**
 * 客户端侧：校验服务端响应。
 *
 * ⚠️ fail-closed：验签失败必须抛错并停止，不得"继续使用该响应"。
 *    否则中间人可以把余额改成很大、把策略改成无限额。
 */
function verifyResponseSignature(p) {
  const { signKey, httpStatus, pathWithQuery, requestNonce, serverTsHeader, signatureHeader, rawBody } = p

  if (!signatureHeader || !serverTsHeader) {
    throw new AppError('AUTH_SIGN_MISSING', '服务端响应缺少 X-Lic-Sign 或 X-Lic-Server-Ts')
  }
  const expected = signResponseRaw({
    signKey, httpStatus, pathWithQuery, requestNonce,
    serverTimeMs: Number(serverTsHeader), rawBody,
  })
  if (!safeEqualHex(expected, String(signatureHeader))) {
    throw new AppError('AUTH_SIGN_INVALID', '服务端响应签名校验失败，连接可能被篡改')
  }
  return true
}

// ═══════════════════════════════════════════════════════════
// login_proof（§4.1）
// ═══════════════════════════════════════════════════════════

/**
 * 登录响应自证。
 *
 * ⚠️ 解决的问题：登录响应本身携带 `sign_key`，无法用它给自己签名
 *    （鸡生蛋）。因此改用**密码派生密钥**签名，客户端用同一派生
 *    方式复算即可确认响应未被篡改。
 */
function deriveLoginKey(password, account, deviceId) {
  return crypto
    .pbkdf2Sync(password, `dsh-login|${account}|${deviceId}`, 100000, 32, 'sha256')
    .toString('hex')
}

/** 覆盖范围排除 login_proof 自身。 */
function buildLoginProof(password, account, deviceId, responseBody) {
  const key = deriveLoginKey(password, account, deviceId)
  const { login_proof, ...rest } = responseBody
  return hmacHex(key, sha256Hex(stableJson(rest)))
}

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

/**
 * login_proof 用的确定性序列化。
 *
 * ⚠️ 这里用确定性 JSON 而非原始字节，因为 login_proof 覆盖的是
 *    "已解析的响应对象"（两端都是我们自己的实现）。但 key 顺序
 *    必须两端一致——所以必须排序。
 */
function stableJson(value) {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'undefined') return undefined
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`不允许非有限数字 ${value}`)
    return String(value)
  }
  if (t === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map((v) => {
      const s = stableJson(v)
      return s === undefined ? 'null' : s
    }).join(',') + ']'
  }
  if (t === 'object') {
    const parts = []
    for (const k of Object.keys(value).sort()) {
      const s = stableJson(value[k])
      if (s === undefined) continue
      parts.push(`${JSON.stringify(k)}:${s}`)
    }
    return '{' + parts.join(',') + '}'
  }
  return undefined
}

module.exports = {
  SIGN_ALGO,
  SIGN_TS_TOLERANCE_MS,
  NONCE_MIN_LEN,
  NONCE_MAX_LEN,
  generateSignKey,
  generateToken,
  sha256Hex,
  hmacHex,
  safeEqualHex,
  buildRequestSignString,
  signRequest,
  verifyRequestSignature,
  buildResponseSignString,
  signResponseRaw,
  verifyResponseSignature,
  deriveLoginKey,
  buildLoginProof,
  verifyLoginProof,
  stableJson,
}
