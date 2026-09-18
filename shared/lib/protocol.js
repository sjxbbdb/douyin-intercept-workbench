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

module.exports = {
  PROTOCOL_VERSION, API_PREFIX,
  SOURCE_TYPES, VERDICTS, SOURCE_COUNTERS, CONFIRM_SIGNALS, FAILURE_REASONS,
  PLATFORM_ENDPOINTS, BILLING_STATUS, ACCOUNT_TIERS, TIER_DAY_BOUNDARIES,
  MS_PER_DAY, TZ_OFFSET_MINUTES,
}