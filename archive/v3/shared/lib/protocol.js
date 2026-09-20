'use strict'

const PROTOCOL_VERSION = 2
const API_PREFIX = '/api/v1'

const SOURCE_TYPES = Object.freeze(['comment', 'live_danmaku', 'dm'])

// ⚠️ verdict = 一次【发送尝试】的判定，闭集仅四个值（protocol.md §7.2）。
//    约束：sent_confirmed + sent_confirmed_dom + sent_suspected + failed = reply_attempts
//    ⚠️ 不含 `skipped`：skipped 是"命中但未发起回复"（§7.1），无 send_id、
//       不产生 send_log 行，只在聚合上报的 sources.<src>.skipped 中计数。
const VERDICTS = Object.freeze([
  'sent_confirmed', 'sent_confirmed_dom', 'sent_suspected', 'failed',
])

// 聚合上报 sources.<src> 的计数字段（protocol.md §7.1）。注意 skipped 在此处，
// 而不是在 VERDICTS 中——两者语义不同，不可混用。
const SOURCE_COUNTERS = Object.freeze([
  'hits', 'leads_new', 'reply_attempts', 'sent_confirmed', 'sent_confirmed_dom',
  'sent_suspected', 'failed', 'skipped', 'unique_users',
])

const CONFIRM_SIGNALS = Object.freeze(['platform_response', 'dom_stable', 'none'])

// ⚠️ 闭集：未知键必须拒绝整条上报（protocol.md §7.4 / §8.2）
const FAILURE_REASONS = Object.freeze([
  'rate_limited', 'login_expired', 'element_timeout', 'network_error',
  'risk_control_rejected', 'content_rejected', 'blocked_by_target',
  'account_risk', 'unknown',
])

// ⚠️ 闭集：禁止完整 URL 与域名（protocol.md §4.8）
const PLATFORM_ENDPOINTS = Object.freeze([
  'comment/publish', 'comment/reply', 'im/send', 'live/comment/send',
])

const BILLING_STATUS = Object.freeze([
  'billed', 'duplicate', 'not_billable', 'policy_exceeded', 'unbilled_insufficient_credit',
])

const ACCOUNT_TIERS = Object.freeze(['observation', 'warm_up', 'ramp_up', 'stable'])

// ⚠️ 时间口径常量放这里（而不是某一端），因为**双端必须完全一致**：
//    "哪一天"的定义如果两端不同，配额计算与计费就会错位。
//    shared/lib 是唯一允许双端共享的地方。
const MS_PER_DAY = 86400000
/** 统计与等级判定的时区偏移（UTC+8，分钟） */
const TZ_OFFSET_MINUTES = 480

// 等级按天数边界（protocol.md §4.6 / §1.4）
const TIER_DAY_BOUNDARIES = Object.freeze([
  { tier: 'observation', day_from: 1,  day_to: 3 },
  { tier: 'warm_up',     day_from: 4,  day_to: 7 },
  { tier: 'ramp_up',     day_from: 8,  day_to: 14 },
  { tier: 'stable',      day_from: 15, day_to: null },
])

// ⚠️ 接口路径与头名放 shared：两端各写一份字符串字面量时，
//    任何一次笔误都表现为"签名对不上"或"404"，排查成本极高。
const PATHS = Object.freeze({
  healthz: '/healthz',
  bootstrap: `${API_PREFIX}/client/bootstrap`,
  login: `${API_PREFIX}/auth/login`,
  refresh: `${API_PREFIX}/auth/refresh`,
  logout: `${API_PREFIX}/auth/logout`,
  me: `${API_PREFIX}/auth/me`,
  heartbeat: `${API_PREFIX}/heartbeat`,
  policyCurrent: `${API_PREFIX}/policy/current`,
  auditSends: `${API_PREFIX}/audit/sends`,
  auditConfigChanges: `${API_PREFIX}/audit/config-changes`,
  usageReport: `${API_PREFIX}/usage/report`,
  creditBalance: `${API_PREFIX}/credit/balance`,
  creditLedger: `${API_PREFIX}/credit/ledger`,
  creditRedeem: `${API_PREFIX}/credit/redeem`,
  accountPlan: `${API_PREFIX}/account/plan`,
})

/** 请求签名头（契约 §5.1） */
const HEADERS = Object.freeze({
  ts: 'X-Lic-Ts',
  nonce: 'X-Lic-Nonce',
  sign: 'X-Lic-Sign',
  serverTs: 'X-Lic-Server-Ts',
  /**
   * ⚠️ `X-Lic-Unsigned` 是本项目补充的**可判定位**（契约 §5.2 的配套约定）：
   *    身份类错误（401/403）发生在会话失效时，此时没有可用密钥，
   *    服务端**只能**返回未签名响应。客户端若把"未签名"一律判为被篡改，
   *    就会在 token 过期时误报安全事件并停机。故用本头显式区分：
   *      · auth        → 身份问题，重新登录即可，**不算篡改**
   *      · 缺失/其他   → fail-closed
   */
  unsigned: 'X-Lic-Unsigned',
})

/** `X-Lic-Unsigned` 的取值 */
const UNSIGNED_REASONS = Object.freeze({
  auth: 'auth',
  noSession: 'no_session',
})

/** 序号通道（契约 §5.4）。各通道独立计数，避免心跳挤掉上报的序号。 */
const SEQ_CHANNELS = Object.freeze(['heartbeat', 'usage', 'sends', 'config_audit'])

/** 序号通道 → 接口路径 */
const CHANNEL_PATH = Object.freeze({
  heartbeat: PATHS.heartbeat,
  usage: PATHS.usageReport,
  sends: PATHS.auditSends,
  config_audit: PATHS.auditConfigChanges,
})

/** 客户端状态（契约 §4.5 state 字段） */
const ENGINE_STATES = Object.freeze(['running', 'paused', 'idle', 'stopped', 'error'])
const BILLING_STATES = Object.freeze(['active', 'degraded', 'idle', 'exhausted', 'suspended'])

/** 服务端下发的命令类型（契约 §4.5 commands[]） */
const COMMAND_TYPES = Object.freeze([
  'pause_engine', 'resume_engine', 'throttle', 'circuit_break',
  'reload_policy', 'force_upgrade',
])

module.exports = {
  PROTOCOL_VERSION, API_PREFIX, PATHS, HEADERS, UNSIGNED_REASONS,
  SEQ_CHANNELS, CHANNEL_PATH, ENGINE_STATES, BILLING_STATES, COMMAND_TYPES,
  SOURCE_TYPES, VERDICTS, SOURCE_COUNTERS, CONFIRM_SIGNALS, FAILURE_REASONS,
  PLATFORM_ENDPOINTS, BILLING_STATUS, ACCOUNT_TIERS, TIER_DAY_BOUNDARIES,
  MS_PER_DAY, TZ_OFFSET_MINUTES,
}