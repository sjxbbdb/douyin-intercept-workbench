'use strict'

// client/license/auth.js
//
// 登录 / 续期 / 登出 —— 契约 §4.1 §4.2 §4.4 与 §9.1。
//
// ⚠️ 本模块最容易被做错、也最贵的一处是 **`login_proof` 校验**：
//
//    登录响应本身携带 `sign_key`，所以它**不可能**给自己签名（鸡生蛋）。
//    契约的解法是用**密码派生密钥**：客户端用同一 PBKDF2 参数复算，
//    就能确认"这份响应确实来自知道我密码的服务端"。
//
//    若漏掉这一步，攻击者只要伪造一次登录响应（改余额、改 policy 上限）
//    就能让客户端在"看起来正常"的状态下满速发送 → 账号被封。
//    **因此校验失败必须拒绝登录，且不得落盘任何凭据。**
//
// ⚠️ 第二个易错点：`force_upgrade`。版本闸门在 `bootstrap` 阶段，
//    必须在**登录之前**判定。若放到登录之后，旧客户端会先拿到 token
//    再被要求升级，中途那段时间它已经在按旧字段限流了。

const shared = require('../../shared/lib/sign')
const { AppError } = require('../../shared/lib/errors')
const { PATHS, PROTOCOL_VERSION, SEQ_CHANNELS } = require('../../shared/lib/protocol')
const keys = require('./keys')

/** 版本号比较：`a < b` 返回负数。仅支持 `x.y.z` 与可选后缀。 */
function compareVersion(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

class LicenseAuth {
  /**
   * @param {object} opts
   * @param {object} opts.http    LicenseHttp
   * @param {object} opts.state   LicenseState
   * @param {string} opts.clientVersion
   * @param {object} [opts.logger]
   * @param {(evt:object)=>void} [opts.onSecurityEvent]
   */
  constructor(opts) {
    if (!opts || !opts.http || !opts.state) throw new Error('LicenseAuth 需要 http 与 state')
    this.http = opts.http
    this.state = opts.state
    this.clientVersion = opts.clientVersion || '0.0.0'
    this.logger = opts.logger || null
    this.onSecurityEvent = opts.onSecurityEvent || null

    /** 最近一次 bootstrap 结果 */
    this.bootstrapInfo = null
    /**
     * 凭据是否失效（被踢/停用/过期）。
     * ⚠️ 一旦为 true，上层必须停发并提示重新登录——不是"重试一下"。
     */
    this.credentialInvalid = null
  }

  #security(code, detail) {
    const evt = { code, at_ms: Date.now(), ...detail }
    if (this.logger) this.logger.error('security_event', evt)
    if (this.onSecurityEvent) this.onSecurityEvent(evt)
    return evt
  }

  /**
   * 版本闸门（契约 §4.4）。
   *
   * ⚠️ `force_upgrade=true` 或 `client_version < min_client_version` →
   *    **必须停机并展示升级页**，不允许登录。
   *    这里直接抛 `SERVER_VERSION_UNSUPPORTED`，由上层切到升级界面。
   */
  async bootstrap() {
    const res = await this.http.requestUnsigned({
      method: 'GET',
      path: `${PATHS.bootstrap}?client_version=${encodeURIComponent(this.clientVersion)}`
        + `&protocol_version=${PROTOCOL_VERSION}&os=${encodeURIComponent(process.platform)}`,
    })
    const b = res.body || {}
    this.bootstrapInfo = b

    // ⚠️ 只看 `maintenance.active`。不要去猜 `server_status` 的取值——
    //    契约里 `server_status` 是自由文本，而维护状态有独立布尔字段。
    //    用未定义的语义做判断，会在服务端措辞变化时误判成维护中。
    if (b.maintenance && b.maintenance.active === true) {
      throw new AppError('SERVER_UNAVAILABLE', b.maintenance.message || '授权中心正在维护，请稍后再试', {
        maintenance_active: true,
      })
    }

    const minV = b.min_client_version
    if (b.force_upgrade === true || (minV && compareVersion(this.clientVersion, minV) < 0)) {
      throw new AppError(
        'SERVER_VERSION_UNSUPPORTED',
        `客户端版本过低（当前 ${this.clientVersion}，要求 ${minV}），请升级后使用`,
        { current: this.clientVersion, required: minV, upgrade_url: b.upgrade_url || null }
      )
    }

    // ⚠️ 服务端下发的 limits 覆盖本地默认值。心跳间隔等参数必须听服务端的，
    //    否则"服务端想降频"这个运维手段就失效了。
    if (b.limits) this.http.limits = b.limits
    return b
  }

  /**
   * 登录（契约 §4.1 + §9.1 场景一）。
   *
   * @param {string} account
   * @param {string} password  **只在本次调用内存在**，不落盘、不进日志
   * @returns {Promise<{body:object, policy:object, quotaNotice:object, warnings:string[]}>}
   */
  async login(account, password) {
    if (!account || !password) throw new Error('login 需要 account 与 password')

    const payload = this.state.loginPayload(account, password)
    const deviceId = payload.device_id

    // ⚠️ 登录接口**不签名**（契约 §4.1）：此刻手上还没有 sign_key。
    const res = await this.http.requestUnsigned({ method: 'POST', path: PATHS.login, body: payload })
    const body = res.body || {}

    // ── ① login_proof：先验真伪，再碰任何字段 ───────────────
    const proof = shared.verifyLoginProof(password, account, deviceId, body)
    if (!proof.ok) {
      // ⚠️ 契约 §9.1：校验失败 → 拒绝登录且**不落盘任何凭据**。
      this.#security('login_proof_invalid', {
        account_len: String(account).length,
        hint: '登录响应未能通过密码派生密钥校验，存在中间人篡改可能',
      })
      const warnings = []
      if (deviceId !== this.state.deviceIdValue) {
        // 说明是本次调用刚生成的新 device_id；未被采纳，但盘上留下了它。
        // 这不算凭据，但要提示——否则排障者会看到"device_id 变了"却无解释。
        warnings.push('本次登录前已生成新的 device_id（未落盘凭据）')
      }
      throw new AppError('AUTH_SIGN_INVALID', '登录响应校验失败，可能存在网络篡改，已拒绝登录', {
        warnings, reason: proof.code,
      })
    }

    // ── ② 采纳凭据 ─────────────────────────────────────────
    this.state.adoptSession(body)
    const skew = this.http.calibrateClock(body.server_time_ms, res.receivedAtMs)
    this.state.setClockSkew(skew)
    this.state.markHeartbeat(0)

    // ── ③ 新会话：换 sessionId 并重置 seq 通道 ──────────────
    this.state.startSession()

    this.credentialInvalid = null

    const warnings = []
    if (body.kicked_device_id) {
      warnings.push(`设备数已达上限，已顶替设备 ${body.kicked_device_id} 上的会话`)
    }
    if (!body.policy) {
      // 没有策略就发不了（护栏 fail-closed），必须明确告知而不是静默。
      warnings.push('登录响应未包含 policy，发送将保持暂停直到取得策略')
    } else if (body.policy.sending_enabled === false) {
      warnings.push(
        (body.quota_notice && body.quota_notice.headline)
        || '当前处于观察期，仅采集线索，暂不发送'
      )
    }
    if (this.http.limits === null && body.limits) this.http.limits = body.limits

    if (this.logger) {
      this.logger.info('login_ok', {
        account_id: this.state.accountId,
        tier: body.policy ? body.policy.account_tier : null,
        clock_skew_ms: skew,
      })
    }

    return { body, policy: body.policy || null, quotaNotice: body.quota_notice || null, warnings }
  }

  /**
   * 续期（契约 §4.2）。
   *
   * ⚠️ 契约允许用**已过期**的 token 调本接口——否则过期即必须重输密码，
   *    体验不可接受。所以本接口在服务端**不要求签名**（无可用密钥时
   *    无法签名），但仍需 Bearer token。
   *
   * ⚠️ 幂等：`token_overlap_ms` 内并发 refresh 返回同一个新 token。
   */
  async refresh() {
    const snap = this.state.authSnapshot()
    if (!snap.token) throw new AppError('AUTH_TOKEN_MISSING', '尚未登录，无法续期')

    const res = await this.http.requestWithToken({
      method: 'POST',
      path: PATHS.refresh,
      body: {
        device_id: this.state.ensureDeviceId(),
        client_version: this.clientVersion,
        protocol_version: PROTOCOL_VERSION,
      },
      headers: { Authorization: `Bearer ${snap.token}` },
    })

    const body = res.body || {}
    // ⚠️ 续期响应**同样没有 login_proof**（它的密钥就在响应里）。
    //    这里不引入新的信任锚：续期请求本身用了旧 token 作为 Bearer，
    //    而旧 token 只有本机与服务端知道——比重新输入密码更弱，
    //    但这是契约设计。风险由"服务端只接受未过期/刚过期 token"约束。
    this.state.adoptSession(body)
    const skew = this.http.calibrateClock(body.server_time_ms, res.receivedAtMs)
    this.state.setClockSkew(skew)

    // ⚠️ 续期**不换 sessionId**：换了就要求 seq 归零，而旧 session 的
    //    seq 已推进，服务端会按新 session 接受从 1 开始——这没问题，
    //    但会让"同一进程内 seq 单调"这条排查线索断掉。契约也未要求。
    this.credentialInvalid = null
    if (this.logger) this.logger.info('refresh_ok', { account_id: this.state.accountId })
    return body
  }

  /** 登出（契约 §4.2，幂等）。 */
  async logout(reason = 'user_logout') {
    const snap = this.state.authSnapshot()
    if (!snap.token) return { ok: true, revoked_session_count: 0 }

    try {
      const res = await this.http.requestWithToken({
        method: 'POST',
        path: PATHS.logout,
        body: { device_id: this.state.ensureDeviceId(), reason },
        headers: { Authorization: `Bearer ${snap.token}` },
      })
      return res.body || { ok: true, revoked_session_count: 0 }
    } finally {
      // ⚠️ 无论服务端是否成功，本地凭据都必须清掉——否则用户点了"退出"
      //    却发现重启后还在运行，是明确的安全预期违背。
      this.state.clearSession(`logout:${reason}`)
    }
  }

  /**
   * 处理需要重新登录的情况（被踢、停用、过期、密钥未知）。
   *
   * ⚠️ 这里是**安全事件的记录点**，因为它对应"服务端已经不再认这台设备"。
   *    静默重试会让客户端在无效凭据上反复请求，且掩盖"账号被停用"这类
   *    必须让商家知道的事实。
   */
  markCredentialInvalid(code, detail) {
    this.credentialInvalid = { code, detail: detail || null, at_ms: Date.now() }
    this.state.clearSession(`invalid:${code}`)
    this.#security('credential_invalid', { code, ...detail })
    return this.credentialInvalid
  }

  /**
   * 判断某个错误码是否属于"必须重新登录"。
   * 依据 `shared/lib/errors.js` 的登记，不在这里自造字符串。
   */
  static isReauthRequired(code) {
    return [
      'AUTH_TOKEN_INVALID', 'AUTH_TOKEN_EXPIRED', 'AUTH_TOKEN_REVOKED',
      'AUTH_ACCOUNT_DISABLED', 'AUTH_ACCOUNT_EXPIRED', 'AUTH_SIGN_KEY_UNKNOWN',
      'AUTH_DEVICE_LIMIT',
    ].includes(code)
  }

  /** 判断是否需要停机（不允许继续任何发送）。 */
  static isStopRequired(code) {
    return [
      'AUTH_ACCOUNT_DISABLED', 'AUTH_ACCOUNT_EXPIRED', 'SERVER_VERSION_UNSUPPORTED',
      'CREDIT_ACCOUNT_SUSPENDED', 'AUTH_SIGN_INVALID', 'AUTH_SIGN_MISSING',
    ].includes(code)
  }

  /**
   * 采纳密钥轮换（契约 §5.4）。由心跳与续期路径共同调用。
   */
  adoptRotation(body) {
    const merged = keys.mergeRotation({
      key: this.state.authSnapshot().key,
      pendingKey: this.state.authSnapshot().pendingKey,
      pendingAtMs: this.state.authSnapshot().pendingAtMs,
      prevKey: null,
      prevKeyExpiresAtMs: 0,
    }, body, Date.now() + this.http.clockSkewMs)

    const r = this.state.adoptRotation(merged)
    if (r.changed && this.logger) this.logger.info('sign_key_rotation', { reason: r.reason })
    return r
  }

  /** 供上报层拼接 `applied_*` 字段（契约 §4.5 的 ack）。 */
  appliedPolicyFields() {
    const p = this.state.policy
    if (!p) return { applied_policy_version: null, applied_policy_hash: null }
    return {
      applied_policy_version: Number(p.policy_version),
      applied_policy_hash: p.policy_hash || null,
    }
  }

  /** 序号通道清单（供上层校验拼包时不漏通道）。 */
  static SEQ_CHANNELS = SEQ_CHANNELS
}

/** 请求 logger 可写的 `headers` 形态，这里统一转成普通对象。 */
function plainHeaders(h) {
  return h && typeof h === 'object' ? { ...h } : {}
}

module.exports = {
  LicenseAuth,
  compareVersion,
  plainHeaders,
}
