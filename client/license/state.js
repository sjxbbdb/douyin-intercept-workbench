'use strict'

// client/license/state.js
//
// 凭据与会话状态的**单点持有者**。
//
// ⚠️ 为什么单独一层而不把 token 散在各处：
//   凭据有三个必须原子地一起更新的字段——`token`、`sign_key`、`clock_skew_ms`。
//   续期时若只更新了其中两个（例如 token 换了、key 忘换），表现是
//   "偶尔 401"，且只在续期之后出现，极难复现。收敛到一处读写即可根治。
//
// ⚠️ 落盘边界（红线 3）：
//   · **落盘**：服务端签发的 token / sign_key / 时钟偏移 / 会话与序号
//   · **绝不落盘**：工作台账号密码（只在登录请求里出现一次，用完即丢）、
//     抖音 Cookies（本项目从不接触）、评论与回复原文
//   · 文件权限尽力收紧到 0600（Windows 上 chmod 语义有限，但 Unix 上有效；
//     不因此放弃，因为服务端也跑在这个仓库里）
//
// ⚠️ 明文存 sign_key 是契约要求（§5：客户端持久化到受保护目录）。
//    不额外加密：加密密钥只能存在同一台机器上，拿不到真实安全性，
//    却会引入"密钥解密失败 → 无法发送"的新故障面。

const fs = require('node:fs')
const os = require('node:os')
const crypto = require('node:crypto')

const { PROTOCOL_VERSION, SEQ_CHANNELS } = require('../../shared/lib/protocol')
const { redactKeyState } = require('./keys')

/** 状态文件 schema 版本。结构变更时递增并写迁移。 */
const STATE_VERSION = 1

class LicenseState {
  /**
   * @param {object} opts
   * @param {object} opts.store            客户端 Store（唯一写盘者）
   * @param {string} opts.instanceDir      实例目录
   * @param {string} opts.clientVersion
   * @param {() => number} [opts.now]
   */
  constructor(opts) {
    if (!opts || !opts.store || !opts.instanceDir) {
      throw new Error('LicenseState 需要 store 与 instanceDir')
    }
    this.store = opts.store
    this.instanceDir = opts.instanceDir
    this.clientVersion = opts.clientVersion || '0.0.0'
    this.now = opts.now || (() => Date.now())

    this.state = this.store.readJson('license-state.json', defaultState())
    this.#normalize()
  }

  #normalize() {
    const s = this.state
    s.schemaVersion = STATE_VERSION
    s.seq = s.seq && typeof s.seq === 'object' ? s.seq : {}
    for (const ch of SEQ_CHANNELS) {
      if (!Number.isInteger(s.seq[ch]) || s.seq[ch] < 0) s.seq[ch] = 0
    }
    s.clockSkewMs = Number(s.clockSkewMs || 0)
    s.sessionId = s.sessionId || null
    s.key = s.key || null
    s.pendingKey = s.pendingKey || null
  }

  #persist() {
    this.state.updatedAtMs = this.now()
    this.store.writeJson('license-state.json', this.state)
    restrictPermissions(this.store.file('license-state.json'))
    return this.state
  }

  // ── 供 http 层读取（每次请求都调，必须便宜）───────────────

  /**
   * 传输层要的凭据快照。
   * ⚠️ 返回的是**浅拷贝**：传输层不得持有 state 内部引用并改它，
   *    否则绕过 #persist 就会出现"内存已换 key、盘上还是旧的"。
   */
  authSnapshot() {
    return {
      token: this.state.token || null,
      key: this.state.key || null,
      pendingKey: this.state.pendingKey || null,
      pendingAtMs: Number(this.state.pendingAtMs || 0),
      keyExpiresAtMs: Number(this.state.keyExpiresAtMs || 0),
      tokenExpiresAtMs: Number(this.state.tokenExpiresAtMs || 0),
      clockSkewMs: Number(this.state.clockSkewMs || 0),
    }
  }

  get isLoggedIn() {
    return Boolean(this.state.token && this.state.key)
  }

  get accountId() { return this.state.accountId || null }
  get sessionId() { return this.state.sessionId || null }
  get policy() { return this.state.policy || null }
  get policyVersion() {
    return this.state.policy ? Number(this.state.policy.policy_version) : null
  }
  get quotaNotice() { return this.state.quotaNotice || null }
  get credit() { return this.state.credit || null }
  get account() { return this.state.account || null }
  get limits() { return this.state.limits || null }
  get privacySalt() { return this.state.privacySalt || null }
  /** 服务端下发的实例 ID（登录响应带回，用于 policy_ack_log 分区）。 */
  get instanceIdValue() { return this.state.instanceId || null }

  /**
   * 设备指纹：32 hex（契约 §4.1）。
   *
   * ⚠️ 取"机器 + 安装"的稳定哈希，而不是网卡 MAC（会变、且涉及隐私）
   *    或随机数（重装即换设备，会吃掉设备数配额）。
   *    同一台机器重装客户端应保持同一 device_id。
   *
   * ⚠️ 方法名与状态字段同名（`this.state.deviceId`），所以这里用
   *    `ensureDeviceId()` 而**不是**直接定义实例属性 `this.deviceId`——
   *    后者会把方法覆盖成字符串，调用一次之后再也调不通。
   */
  ensureDeviceId() {
    if (this.state.deviceId) return this.state.deviceId
    const seed = [
      os.hostname(),
      os.platform(),
      os.arch(),
      // 用户名参与哈希是为了区分"同一台机器上的不同 Windows 账户"，
      // 它本身不以明文出现在任何上报里。
      safeUsername(),
    ].join('|')
    this.state.deviceId = sha256Hex(seed).slice(0, 32)
    this.#persist()
    return this.state.deviceId
  }

  /** 已生成的设备指纹（未生成则为 null，不触发写入）。 */
  get deviceIdValue() {
    return this.state.deviceId || null
  }

  /**
   * 安装 ID（uuid v4，重装后变化，契约 §4.1）。
   */
  installId() {
    if (this.state.installId) return this.state.installId
    this.state.installId = crypto.randomUUID()
    this.#persist()
    return this.state.installId
  }

  /**
   * 会话 ID：**每次进程启动生成新的**（契约 §4.5）。
   *
   * ⚠️ 为什么每次启动都换：服务端的防重放按 `(account, device, session, channel)`
   *    记 `max_seq`，新 session 允许 seq 从 1 重新开始。若沿用旧 sessionId
   *    且 seq 被重置，服务端会判 `AUTH_REPLAY`（序号未递增）。
   */
  startSession() {
    this.state.sessionId = crypto.randomUUID()
    this.state.sessionStartedAtMs = this.now()
    // ⚠️ seq 必须随新 session 归零。保留旧值只会浪费序号，
    //    且一旦与旧 session 混淆会直接触发重放判定。
    for (const ch of SEQ_CHANNELS) this.state.seq[ch] = 0
    this.#persist()
    return this.state.sessionId
  }

  /**
   * 预留一个序号并**先落盘再返回**（契约 §4.5 的 seq 单调性）。
   *
   * ⚠️ 顺序不能反。若先发送后落盘：进程在两者之间崩溃 → 重启读到的 seq
   *    比实际已用的小 → 用同一个 seq 重发 → 服务端判 `AUTH_REPLAY`，
   *    该请求整体无效且触发安全告警。号码只能浪费，不能回退。
   */
  nextSeq(channel) {
    if (!SEQ_CHANNELS.includes(channel)) {
      throw new Error(`未知序号通道 ${channel}（允许：${SEQ_CHANNELS.join('/')}）`)
    }
    this.state.seq[channel] += 1
    this.#persist()
    return this.state.seq[channel]
  }

  /** 只读当前序号（排障用，不推进）。 */
  peekSeq(channel) {
    return Number(this.state.seq[channel] || 0)
  }

  // ── 写入 ──────────────────────────────────────────────────

  /**
   * 采纳登录/续期响应。
   *
   * ⚠️ 由调用方在**验签通过之后**调用，本方法不再校验签名——
   *    但会拒绝写入明显不完整的凭据（宁可登录失败，不可半截凭据）。
   */
  adoptSession(body) {
    const missing = []
    if (!body || typeof body.token !== 'string' || !body.token) missing.push('token')
    if (!body || typeof body.sign_key !== 'string' || !body.sign_key) missing.push('sign_key')
    if (missing.length) {
      throw new Error(`登录响应缺少必要字段：${missing.join(', ')}。拒绝写入不完整的凭据。`)
    }

    this.state.token = body.token
    this.state.tokenExpiresAtMs = Number(body.token_expires_ms || 0)
    this.state.key = body.sign_key
    this.state.signKeyExpiresAtMs = Number(body.sign_key_expires_ms || 0)
    // 采纳新密钥即作废未生效的轮换（否则旧 pending 会在新会话上生效）
    this.state.pendingKey = null
    this.state.pendingAtMs = 0

    if (body.privacy_salt) {
      this.state.privacySalt = body.privacy_salt
      this.state.privacySaltVersion = Number(body.privacy_salt_version || 1)
    }
    if (body.account) this.state.account = body.account
    if (body.credit) this.state.credit = body.credit
    if (body.policy) {
      this.state.policy = body.policy
      this.state.policyAppliedAtMs = this.now()
      this.state.policyAckedVersion = null // 新策略需要重新 ack
    }
    if (body.quota_notice) this.state.quotaNotice = body.quota_notice
    if (body.limits) this.state.limits = body.limits
    if (body.account && body.account.account_id) this.state.accountId = body.account.account_id
    if (body.protocol_version) this.state.protocolVersion = Number(body.protocol_version)
    // ⚠️ 必须存 instance_id：服务端拿它当 policy_ack_log 的分区键。
    //    丢了它 → 心跳的 ack 写不进库 → 红线 3 的存证链断裂
    //    （出事时回答不了"当时实际生效的策略是什么"）。
    if (body.instance_id) this.state.instanceId = String(body.instance_id)

    return this.#persist()
  }

  /** 采纳心跳下发的新策略（契约 §4.5：60 秒内切换，下一次心跳 ack）。 */
  adoptPolicy(policy) {
    if (!policy || typeof policy !== 'object') throw new Error('adoptPolicy 需要 policy 对象')
    const prev = this.state.policy ? Number(this.state.policy.policy_version) : null
    const cur = Number(policy.policy_version)
    this.state.policy = policy
    this.state.policyAppliedAtMs = this.now()
    if (prev !== cur) this.state.policyAckedVersion = null
    return this.#persist()
  }

  /** 记录已完成 ack 的策略版本。 */
  markPolicyAcked(version) {
    this.state.policyAckedVersion = Number(version)
    return this.#persist()
  }

  /** 心跳返回的余额/配额（服务端为权威）。 */
  adoptHeartbeatResult(resp) {
    if (resp.credit) this.state.credit = resp.credit
    if (resp.daily_quota) this.state.dailyQuota = resp.daily_quota
    if (resp.circuit_breaker) this.state.serverCircuit = resp.circuit_breaker
    if (resp.state) this.state.billingState = resp.state
    if (resp.state_reason !== undefined) this.state.billingStateReason = resp.state_reason
    this.state.lastHeartbeatMs = this.now()
    return this.#persist()
  }

  /**
   * 采纳密钥轮换信息（契约 §5.4）。
   * @returns {{changed:boolean, reason:string|null}}
   */
  adoptRotation(merged) {
    if (!merged || !merged.changed) return { changed: false, reason: null }
    this.state.key = merged.state.key
    this.state.pendingKey = merged.state.pendingKey
    this.state.pendingAtMs = merged.state.pendingAtMs
    this.state.prevKey = merged.state.prevKey
    this.state.prevKeyExpiresAtMs = merged.state.prevKeyExpiresAtMs
    this.#persist()
    return { changed: true, reason: merged.reason }
  }

  setClockSkew(ms) {
    const v = Number(ms)
    if (!Number.isFinite(v)) return
    if (this.state.clockSkewMs === v) return
    this.state.clockSkewMs = v
    this.#persist()
  }

  /** 服务端下发的余额（唯一权威来源）。 */
  setBalanceMilli(milli) {
    const v = Number(milli)
    if (!Number.isFinite(v)) throw new Error(`余额必须是数字，收到：${milli}`)
    this.state.credit = { ...(this.state.credit || {}), balance_milli: v, updated_at_ms: this.now() }
    return this.#persist()
  }

  /** 记录上一次成功心跳时刻（离线判定的依据）。 */
  markHeartbeat(atMs) {
    this.state.lastHeartbeatMs = atMs === undefined ? this.now() : atMs
    return this.#persist()
  }

  /**
   * 清除**凭据**（登出、被踢、账号停用）。
   *
   * ⚠️ 只清"会话级"的东西：token / sign_key / sessionId / seq。
   *    **不清 policy / credit / quota_notice** —— 理由：
   *    · 这些是"已知的服务端状态"，用于离线展示与影子额度推导。
   *      清掉会让界面在断网重连期间变成空白，商家以为程序坏了。
   *    · 护栏（红线 1）也依赖 `policy` 才能判定能不能发。清掉 policy
   *      会让 `canSend()` 走 fail-closed 分支——**这是对的**，
   *      但不能靠"清数据"来实现；停机应由显式的状态机决定，
   *      否则排查时无法区分"没策略"和"被登出"。
   *
   * ⚠️ 保留 deviceId / installId：重装或重登不应被算成新设备。
   */
  clearSession(reason) {
    this.state.token = null
    this.state.key = null
    this.state.pendingKey = null
    this.state.pendingAtMs = 0
    this.state.prevKey = null
    this.state.tokenExpiresAtMs = 0
    this.state.signKeyExpiresAtMs = 0
    this.state.sessionId = null
    this.state.policyAckedVersion = null
    for (const ch of SEQ_CHANNELS) this.state.seq[ch] = 0
    this.state.lastClearedReason = reason || null
    this.state.lastClearedAtMs = this.now()
    return this.#persist()
  }

  /** 脱敏快照（日志与界面用）。⚠️ 不含 token / sign_key 明文。 */
  redacted() {
    return {
      logged_in: this.isLoggedIn,
      account_id: this.accountId,
      device_id: this.deviceIdValue,
      install_id: this.state.installId || null,
      session_id: this.sessionId,
      token_expires_at_ms: Number(this.state.tokenExpiresAtMs || 0),
      clock_skew_ms: Number(this.state.clockSkewMs || 0),
      policy_version: this.policyVersion,
      policy_acked_version: this.state.policyAckedVersion,
      account_tier: this.state.policy ? this.state.policy.account_tier : null,
      billing_state: this.state.billingState || null,
      last_heartbeat_ms: Number(this.state.lastHeartbeatMs || 0),
      seq: { ...this.state.seq },
      key: redactKeyState({ key: this.state.key, keyExpiresAtMs: this.state.signKeyExpiresAtMs, pendingKey: this.state.pendingKey, pendingAtMs: this.state.pendingAtMs }),
    }
  }

  /** 登录请求体（契约 §4.1）。密码是参数，**不进入任何持久化字段**。 */
  loginPayload(account, password) {
    return {
      account,
      password,
      device_id: this.ensureDeviceId(),
      device_name: deviceName(),
      install_id: this.installId(),
      client_version: this.clientVersion,
      protocol_version: PROTOCOL_VERSION,
      os: os.platform(),
    }
  }
}

// ══════════════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════════════

function defaultState() {
  return {
    schemaVersion: STATE_VERSION,
    token: null,
    tokenExpiresAtMs: 0,
    key: null,
    signKeyExpiresAtMs: 0,
    pendingKey: null,
    pendingAtMs: 0,
    prevKey: null,
    prevKeyExpiresAtMs: 0,
    deviceId: null,
    installId: null,
    sessionId: null,
    sessionStartedAtMs: 0,
    accountId: null,
    account: null,
    credit: null,
    policy: null,
    policyAppliedAtMs: 0,
    policyAckedVersion: null,
    quotaNotice: null,
    dailyQuota: null,
    serverCircuit: null,
    billingState: null,
    billingStateReason: null,
    limits: null,
    privacySalt: null,
    privacySaltVersion: 0,
    protocolVersion: PROTOCOL_VERSION,
    instanceId: null,
    clockSkewMs: 0,
    lastHeartbeatMs: 0,
    lastClearedReason: null,
    lastClearedAtMs: 0,
    seq: {},
    updatedAtMs: 0,
  }
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex')
}

/** 尽力收紧文件权限。失败不阻断（Windows 上 chmod 语义有限）。 */
function restrictPermissions(file) {
  try {
    fs.chmodSync(file, 0o600)
  } catch (e) {
    // ⚠️ 这里**可以**容忍失败，但必须让上层知道——否则"权限没收紧"
    //    这件事会永远无人知晓。所以记录下来而不是空 catch。
    if (typeof restrictPermissions.onFailure === 'function') {
      restrictPermissions.onFailure(file, e)
    }
  }
}
restrictPermissions.onFailure = null

function safeUsername() {
  try {
    return os.userInfo().username
  } catch (e) {
    // 某些受限环境（无 home、服务账户）下 userInfo 会抛。
    // 回退到空串即可——device_id 只要求"同机稳定"，不要求全局唯一。
    return ''
  }
}

function deviceName() {
  const host = os.hostname() || 'unknown'
  return host.length > 40 ? host.slice(0, 40) : host
}

module.exports = {
  LicenseState,
  STATE_VERSION,
  defaultState,
  restrictPermissions,
  sha256Hex,
  deviceName,
}
