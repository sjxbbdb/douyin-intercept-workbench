'use strict'

// test/integration/helpers.js
//
// 集成测试的 HTTP 客户端助手：真实请求 + **按契约真实签名** + 真实验签。
//
// ⚠️ 刻意不 mock 签名。签名的价值就在于"两端算出同一个值"，
//    用 mock 替代等于把最需要验证的环节跳过。
//
// ⚠️ 本文件复刻了客户端必须做的事，因此它同时是**客户端实现的参考**：
//    · 签名字段走请求头 X-Lic-Ts / X-Lic-Nonce / X-Lic-Sign（契约 §5.1）
//    · 签名覆盖 sha256(raw_body_bytes)，不是重新序列化的对象
//    · 路径含 query
//    · 每次请求必须用新 nonce、seq 递增
//    · 响应必须验签，失败即 fail-closed

const http = require('node:http')
const crypto = require('node:crypto')
const {
  signRequest, verifyResponseSignature, verifyLoginProof,
} = require('../../license-server/crypto/sign')

/** 发一个原始 HTTP 请求。返回 { status, raw, body, headers }。 */
function request(addr, method, path, { rawBody, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody === undefined || rawBody === null ? null : rawBody
    const req = http.request({
      host: addr.address === '::' ? '127.0.0.1' : addr.address,
      port: addr.port,
      method,
      path,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...(payload !== null ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body = null
        try { body = raw ? JSON.parse(raw) : null } catch { body = null }
        resolve({ status: res.statusCode, raw, body, headers: res.headers })
      })
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

/**
 * 模拟客户端。持有 token 与 sign_key，自动签名与验签。
 */
class Client {
  constructor(addr, { account, password, deviceId = 'dev-test-1', instanceId = 'inst-1' }) {
    this.addr = addr
    this.account = account
    this.password = password
    this.deviceId = deviceId
    this.instanceId = instanceId
    this.token = null
    this.signKey = null
    this.seq = 0
    this.nonceCounter = 0
    /** 是否校验响应签名。置 false 可测"未验签"的负面路径。 */
    this.verifyResponses = true
    /** 是否校验 login_proof */
    this.verifyLoginProof = true
    this.calls = []
  }

  async login() {
    const rawBody = JSON.stringify({
      account: this.account,
      password: this.password,
      device_id: this.deviceId,
      instance_id: this.instanceId,
      client_version: '3.0.0',
      protocol_version: 2,
    })
    const r = await request(this.addr, 'POST', '/api/v1/auth/login', { rawBody })
    if (r.status === 200 && r.body && r.body.ok) {
      this.token = r.body.token
      this.signKey = r.body.sign_key
      if (this.verifyLoginProof) {
        // 客户端必须自证登录响应——否则可能拿到被篡改的 sign_key
        verifyLoginProof(this.password, this.account, this.deviceId, r.body)
        r.loginProofVerified = true
      }
    }
    return r
  }

  /**
   * nonce 必须是 16~32 位 hex（契约 §5.1）。
   * ⚠️ 用计数器 + 随机，保证同进程内绝对不重复。
   */
  nextNonce() {
    this.nonceCounter++
    const seed = `${this.deviceId}|${Date.now()}|${this.nonceCounter}|${crypto.randomBytes(8).toString('hex')}`
    return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)
  }

  nextSeq() {
    this.seq++
    return this.seq
  }

  /**
   * 发一个已签名的请求。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.channel] 是否递增 seq（false 用于测 seq 回退）
   * @param {boolean} [opts.sign]    是否签名（false 用于测缺签名）
   * @param {number}  [opts.tsOffsetMs] 时间戳偏移（用于测时钟偏斜）
   * @param {number}  [opts.seqOverride] 强制指定 seq
   * @param {object}  [opts.extraHeaders]
   */
  async call(method, path, body = {}, opts = {}) {
    const { channel = true, sign = true, tsOffsetMs = 0, seqOverride, extraHeaders = {} } = opts

    const bodyObj = { ...body }
    if (channel && seqOverride === undefined) bodyObj.seq = this.nextSeq()
    else if (seqOverride !== undefined) bodyObj.seq = seqOverride

    const rawBody = method.toUpperCase() === 'GET' ? null : JSON.stringify(bodyObj)
    const headers = {}
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    Object.assign(headers, extraHeaders)

    const nonce = this.nextNonce()
    const ts = Date.now() + tsOffsetMs

    if (sign && this.signKey) {
      const signature = signRequest({
        signKey: this.signKey,
        method,
        pathWithQuery: path,
        ts,
        nonce,
        rawBody: rawBody === null ? '' : rawBody,
      })
      headers['X-Lic-Ts'] = String(ts)
      headers['X-Lic-Nonce'] = nonce
      headers['X-Lic-Sign'] = signature
    } else if (sign === 'omit-sign-only') {
      headers['X-Lic-Ts'] = String(ts)
      headers['X-Lic-Nonce'] = nonce
    }

    const r = await request(this.addr, method, path, { rawBody, headers })
    this.calls.push({ method, path, status: r.status, rawBody, nonce, ts })

    r.requestNonce = nonce

    // ⚠️ 响应验签规则（按契约 §5.2 的意图精确实现）：
    //    · 已签名的响应 → **必须验签**，失败即 fail-closed 抛错
    //    · 未签名响应：
    //        - 401/403（身份问题，会话已失效/被踢）→ 合法，不抛错。
    //          客户端应重新登录，而不是判为"连接被篡改"。
    //        - 其他状态码 → 视为篡改（fail-closed）。业务错误
    //          （402/409 等）必须签名，否则无法区分真伪。
    r.signatureStatus = r.headers['x-lic-sign']
      ? 'signed'
      : (r.headers['x-lic-unsigned'] || 'missing')

    if (this.verifyResponses && this.signKey && r.signatureStatus === 'signed') {
      verifyResponseSignature({
        signKey: this.signKey,
        httpStatus: r.status,
        pathWithQuery: path,
        requestNonce: nonce,
        serverTsHeader: r.headers['x-lic-server-ts'],
        signatureHeader: r.headers['x-lic-sign'],
        rawBody: r.raw,
      })
      r.verified = true
    } else if (this.verifyResponses && this.signKey) {
      const authFailure = r.status === 401 || r.status === 403
      if (!authFailure) {
        const e = new Error(
          `未签名的响应且状态码为 ${r.status}（应为业务错误，必须签名才能防伪造）：${path}`
        )
        e.code = 'AUTH_SIGN_MISSING'
        throw e
      }
      r.verified = false
      r.unsignedAuth = true
    }
    return r
  }

  get(path, opts) { return this.call('GET', path, {}, opts) }
  post(path, body, opts) { return this.call('POST', path, body, opts) }
}

/** 构造一条合法的发送明细。 */
let sendSeq = 0
function makeSend(overrides = {}) {
  sendSeq++
  return {
    send_id: overrides.send_id || `s-it-${String(sendSeq).padStart(5, '0')}`,
    source_type: 'comment',
    target_hash: 'th-abc',
    user_key_hash: 'uh-abc',
    user_key_type: 'sec_uid_hash',
    content_hash: 'ch-abc',
    verdict: 'sent_confirmed',
    evidence: {
      confirm_signal: 'platform_response',
      platform_endpoint: 'comment/publish',
      platform_status_code: 0,
    },
    sent_at_ms: Date.now(),
    ...overrides,
  }
}

module.exports = { request, Client, makeSend }
