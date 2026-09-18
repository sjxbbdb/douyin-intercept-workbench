'use strict'

// license-server/domain/policy.js
//
// 安全策略引擎 —— **红线 1 的载体**。
//
// ⚠️ 本文件是唯一允许定义安全限额的地方。全项目禁止在其他任何位置
//    硬编码 daily_max / min_interval_ms / content_similarity_max 等数值。
//    理由：平台风控会变，限额必须能统一调整；且客户端可被破解，
//    限额必须由服务端权威判定。
//
// 四件事：
//   1. TREE_TABLE  —— 四级等级表的唯一定义
//   2. deriveTier  —— 由账号天数索引推导等级
//   3. buildPolicy —— 由等级构造下发给客户端的 policy 对象
//   4. validateClientLimits —— 校验客户端上报的生效值"只能更保守"

const crypto = require('node:crypto')
const { stableStringify } = require('../../shared/lib/stable-stringify')
const { AppError } = require('../../shared/lib/errors')
const {
  SOURCE_TYPES, ACCOUNT_TIERS, TIER_DAY_BOUNDARIES, MS_PER_DAY, TZ_OFFSET_MINUTES,
} = require('../../shared/lib/protocol')

// ═══════════════════════════════════════════════════════════
// 1. 等级表（唯一来源）
// ═══════════════════════════════════════════════════════════

/**
 * ⚠️ 四级等级表。数值来自需求规格 FR-2.3.1，与 shared/protocol.md §4.6
 *    的 tier_table 必须逐项一致（契约测试会校验）。
 *
 * 设计意图（不是随便定的数）：
 *   · 观察期上限为 0 —— 新号满速发送是封号第一诱因，前 3 天只采集不发送
 *   · 私信上限显著低于评论 —— 抖音对陌生人私信管控远严于评论
 *   · 间隔随等级递减但仍有下限 —— 给账号适应过程
 *   · 观察期/预热期的间隔取**区间保守端**（更长），因为客户端在此阶段
 *     应该更保守；随等级提升才逐步接近策略下限
 */
const TIER_TABLE = Object.freeze([
  Object.freeze({
    tier: 'observation',
    day_from: 1,
    day_to: 3,
    sending_enabled: false,
    collect_only: true,
    limits: Object.freeze({
      comment: Object.freeze({ daily_max: 0, min_interval_ms: 180000, content_similarity_max: 0.85 }),
      live_danmaku: Object.freeze({ daily_max: 0, min_interval_ms: 90000, content_similarity_max: 0.85 }),
      dm: Object.freeze({ daily_max: 0, min_interval_ms: 900000, content_similarity_max: 0.75 }),
    }),
  }),
  Object.freeze({
    tier: 'warm_up',
    day_from: 4,
    day_to: 7,
    sending_enabled: true,
    collect_only: false,
    limits: Object.freeze({
      comment: Object.freeze({ daily_max: 10, min_interval_ms: 180000, content_similarity_max: 0.85 }),
      live_danmaku: Object.freeze({ daily_max: 10, min_interval_ms: 90000, content_similarity_max: 0.85 }),
      dm: Object.freeze({ daily_max: 3, min_interval_ms: 900000, content_similarity_max: 0.75 }),
    }),
  }),
  Object.freeze({
    tier: 'ramp_up',
    day_from: 8,
    day_to: 14,
    sending_enabled: true,
    collect_only: false,
    limits: Object.freeze({
      comment: Object.freeze({ daily_max: 25, min_interval_ms: 120000, content_similarity_max: 0.85 }),
      live_danmaku: Object.freeze({ daily_max: 25, min_interval_ms: 60000, content_similarity_max: 0.85 }),
      dm: Object.freeze({ daily_max: 8, min_interval_ms: 600000, content_similarity_max: 0.75 }),
    }),
  }),
  Object.freeze({
    tier: 'stable',
    day_from: 15,
    day_to: null,
    sending_enabled: true,
    collect_only: false,
    limits: Object.freeze({
      comment: Object.freeze({ daily_max: 30, min_interval_ms: 60000, content_similarity_max: 0.85 }),
      live_danmaku: Object.freeze({ daily_max: 30, min_interval_ms: 30000, content_similarity_max: 0.85 }),
      dm: Object.freeze({ daily_max: 10, min_interval_ms: 300000, content_similarity_max: 0.75 }),
    }),
  }),
])

/** 客户端可调间隔的允许区间（毫秒）。服务端取值必须落在区间内。 */
const MIN_INTERVAL_MS_RANGE = Object.freeze({
  comment: Object.freeze([60000, 180000]),
  live_danmaku: Object.freeze([30000, 90000]),
  dm: Object.freeze([300000, 900000]),
})

/** 默认活跃时段：单一窗口。客户端只能调更短，不可延长或新增窗口。 */
const ACTIVE_HOURS_DEFAULT = Object.freeze([Object.freeze(['08:00', '23:00'])])

/** 相似度阈值的语义方向（写进下发对象，避免客户端实现时弄反）。 */
const CONTENT_SIMILARITY_SEMANTICS =
  '与近期已发内容的相似度**超过**该值即拒绝发送（0.85 = 相似度 > 85% 拒绝）'

// ⚠️ MS_PER_DAY 与 TZ_OFFSET_MINUTES 从 shared/lib/protocol.js 引入，
//    不在此处重新定义。理由：客户端也要用同一套时间口径，
//    两处定义迟早漂移——而"哪一天"的定义不一致会让配额与计费错位。

// ═══════════════════════════════════════════════════════════
// 2. 等级推导
// ═══════════════════════════════════════════════════════════

/**
 * 计算账号天数索引（从 1 开始）。
 *
 * 契约算法（protocol.md §4.6）：
 *   account_day_index = floor((今日 00:00(UTC+8) − 首次登录日 00:00(UTC+8)) / 86400000) + 1
 *
 * ⚠️ 按**自然日**而非 24 小时窗计算。理由：商家理解的"第 4 天"是日历日，
 *    用滚动 24 小时会让"第 4 天"在一天之内漂移，商家无法预期。
 */
function deriveDayIndex(firstLoginMs, nowMs, tzOffsetMinutes = TZ_OFFSET_MINUTES) {
  if (!Number.isFinite(firstLoginMs) || firstLoginMs <= 0) return 1
  const tzMs = tzOffsetMinutes * 60 * 1000
  const startOfDay = (ms) => Math.floor((ms + tzMs) / MS_PER_DAY)
  const diff = startOfDay(nowMs) - startOfDay(firstLoginMs)
  return Math.max(1, diff + 1)
}

/** 由天数索引取等级定义。 */
function tierForDayIndex(dayIndex) {
  const d = Math.max(1, Math.floor(dayIndex))
  for (const t of TIER_TABLE) {
    if (t.day_to === null) return t
    if (d >= t.day_from && d <= t.day_to) return t
  }
  return TIER_TABLE[TIER_TABLE.length - 1]
}

/** 距离下一档还需几天。已在最高档返回 null。 */
function daysUntilNextTier(dayIndex) {
  const d = Math.max(1, Math.floor(dayIndex))
  for (const t of TIER_TABLE) {
    if (t.day_to !== null && d <= t.day_to) return t.day_to + 1 - d
  }
  return null
}

/** 下一档等级名。已在最高档返回 null。 */
function nextTierName(dayIndex) {
  const d = Math.max(1, Math.floor(dayIndex))
  for (let i = 0; i < TIER_TABLE.length; i++) {
    const t = TIER_TABLE[i]
    if (t.day_to !== null && d <= t.day_to) {
      return TIER_TABLE[i + 1] ? TIER_TABLE[i + 1].tier : null
    }
  }
  return null
}

// ═══════════════════════════════════════════════════════════
// 3. 构造下发对象
// ═══════════════════════════════════════════════════════════

/**
 * 构造 `policy` 对象（随登录与心跳下发）。
 *
 * ⚠️ 含 `policy_hash`：客户端在心跳中 ack 它，服务端写 policy_ack_log 存证。
 *    这是红线 3 要求的"能证明客户端确认应用了哪一版策略"。
 */
function buildPolicy({ accountId, accountDayIndex, policyVersion, nowMs }) {
  const tierDef = tierForDayIndex(accountDayIndex)
  const core = {
    policy_version: policyVersion,
    account_tier: tierDef.tier,
    account_day_index: accountDayIndex,
    tier_day_from: tierDef.day_from,
    tier_day_to: tierDef.day_to,
    sending_enabled: tierDef.sending_enabled,
    collect_only: tierDef.collect_only,
    days_until_next_tier: daysUntilNextTier(accountDayIndex),
    next_tier: nextTierName(accountDayIndex),
    active_hours: { tz_offset_minutes: TZ_OFFSET_MINUTES, windows: ACTIVE_HOURS_DEFAULT },
    limits: tierDef.limits,
    min_interval_ms_range: MIN_INTERVAL_MS_RANGE,
    content_similarity_max_semantics: CONTENT_SIMILARITY_SEMANTICS,
    circuit_breaker: {
      failure_rate_threshold: 0.4,
      failure_rate_window: 20,
      platform_reject_threshold: 3,
      // 递进式熔断：L1 → L2 → L3（停到次日）
      cooldown_ms: 1800000,          // L1: 30 分钟
      cooldown_l2_ms: 3600000,       // L2: 1 小时
      risk_code_cooldown_ms: 86400000, // L3: 停到次日
    },
    idle_pause_ms: 7200000,
  }
  const policy_hash = crypto.createHash('sha256').update(stableStringify(core), 'utf8').digest('hex').slice(0, 16)
  return { ...core, policy_hash, account_id: accountId, generated_at_ms: nowMs }
}

/** 完整等级表（供 GET /policy/current 下发，便于客户端与运维核对）。 */
function tierTableForClient() {
  return {
    tier_table: TIER_TABLE,
    min_interval_ms_range: MIN_INTERVAL_MS_RANGE,
    daily_cap_total_by_tier: Object.fromEntries(
      TIER_TABLE.map((t) => [
        t.tier,
        SOURCE_TYPES.reduce((sum, s) => sum + t.limits[s].daily_max, 0),
      ])
    ),
    stable_daily_max_total: stableDailyMaxTotal(),
    stable_daily_max_total_basis:
      '稳定期各渠道日上限之和，区间取上限：评论 30 + 弹幕 30 + 私信 10 = 70',
    content_similarity_max_semantics: CONTENT_SIMILARITY_SEMANTICS,
    client_may_only_be_more_conservative: true,
  }
}

/** 稳定期日上限合计。⚠️ 套餐积分由它推导，不得另写常量。 */
function stableDailyMaxTotal() {
  const stable = TIER_TABLE.find((t) => t.tier === 'stable')
  return SOURCE_TYPES.reduce((sum, s) => sum + stable.limits[s].daily_max, 0)
}

// ═══════════════════════════════════════════════════════════
// 4. 校验客户端上报的生效值
// ═══════════════════════════════════════════════════════════

/**
 * 校验客户端上报的 `applied_limits` **只能更保守**。
 *
 * ⚠️ 四个方向必须分别判断，最容易弄反的是 content_similarity_max：
 *   · daily_max              只能**调低**（上限更低才更保守）
 *   · min_interval_ms        只能**调高**（间隔更长才更保守），且在允许区间内
 *   · content_similarity_max 只能**调低**（阈值更低 = 更容易拒绝 = 更保守）
 *   · active_hours           只能**调短**，不得延长或新增窗口
 *
 * 任一项比策略更激进 → 抛 POLICY_VIOLATION，detail 给出 field/reported/allowed。
 *
 * @param {object} appliedLimits 客户端上报的实际生效值
 * @param {object} policy 服务端下发的 policy 对象
 * @throws {AppError} POLICY_VIOLATION
 */
function validateClientLimits(appliedLimits, policy) {
  if (appliedLimits === undefined || appliedLimits === null) return true

  // ⚠️ 先拒绝未知来源类型。
  //    只遍历已知渠道是不够的——未知键会被**静默忽略**，等于放行了
  //    一个我们没校验过的配置。契约要求拒绝（POLICY_TIER_UNKNOWN）。
  const knownSources = new Set(SOURCE_TYPES.concat(['active_hours']))
  for (const key of Object.keys(appliedLimits)) {
    if (!knownSources.has(key)) {
      throw new AppError('POLICY_TIER_UNKNOWN', `未知的配置项 ${key}，已拒绝`, {
        field: key,
        allowed_keys: [...knownSources],
        policy_version: policy.policy_version,
      })
    }
  }

  for (const source of SOURCE_TYPES) {
    const applied = appliedLimits[source]
    if (applied === undefined || applied === null) continue

    const allowed = policy.limits[source]
    if (!allowed) {
      throw new AppError('POLICY_TIER_UNKNOWN', `未知来源类型 ${source}`, { field: source })
    }

    assertMoreConservative({
      source,
      field: 'daily_max',
      reported: applied.daily_max,
      allowed: allowed.daily_max,
      // 上报值必须 <= 允许值
      ok: applied.daily_max === undefined || applied.daily_max <= allowed.daily_max,
      policyVersion: policy.policy_version,
    })

    assertMoreConservative({
      source,
      field: 'min_interval_ms',
      reported: applied.min_interval_ms,
      allowed: allowed.min_interval_ms,
      ok: applied.min_interval_ms === undefined || (
        applied.min_interval_ms >= allowed.min_interval_ms &&
        applied.min_interval_ms <= MIN_INTERVAL_MS_RANGE[source][1]
      ),
      policyVersion: policy.policy_version,
    })

    assertMoreConservative({
      source,
      field: 'content_similarity_max',
      reported: applied.content_similarity_max,
      allowed: allowed.content_similarity_max,
      ok: applied.content_similarity_max === undefined ||
        applied.content_similarity_max <= allowed.content_similarity_max,
      policyVersion: policy.policy_version,
    })
  }

  if (appliedLimits.active_hours !== undefined && appliedLimits.active_hours !== null) {
    if (!isActiveHoursShorterOrEqual(appliedLimits.active_hours, policy.active_hours)) {
      throw new AppError(
        'POLICY_VIOLATION',
        '活跃时段只能调短，不能延长或新增窗口',
        {
          field: 'active_hours',
          reported: appliedLimits.active_hours,
          allowed: policy.active_hours,
          policy_version: policy.policy_version,
        }
      )
    }
  }

  return true
}

function assertMoreConservative({ source, field, reported, allowed, ok, policyVersion }) {
  if (ok) return
  throw new AppError(
    'POLICY_VIOLATION',
    `${source}.${field} 比服务端策略更激进，已拒绝`,
    { source_type: source, field, reported, allowed, policy_version: policyVersion }
  )
}

/** "HH:MM" → 分钟数 */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm))
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * 判断客户端活跃时段是否为服务端时段的子集（更短或相等）。
 * ⚠️ 不得新增窗口，也不得超出服务端窗口边界。
 */
function isActiveHoursShorterOrEqual(clientHours, serverHours) {
  const cw = clientHours && clientHours.windows
  const sw = serverHours && serverHours.windows
  if (!Array.isArray(cw) || !Array.isArray(sw)) return false
  if (cw.length > sw.length) return false // 窗口数量不得增加
  if (cw.length === 0) return true // 空 = 完全不发送，最保守

  const server = sw.map((w) => ({ s: toMinutes(w[0]), e: toMinutes(w[1]) }))
  if (server.some((w) => w.s === null || w.e === null)) return false

  for (const w of cw) {
    const s = toMinutes(w[0])
    const e = toMinutes(w[1])
    if (s === null || e === null) return false
    if (s >= e) return false // 不支持跨天窗口
    // 必须完全落在服务端某个窗口内
    const contained = server.some((sv) => s >= sv.s && e <= sv.e)
    if (!contained) return false
  }
  return true
}

// ═══════════════════════════════════════════════════════════
// 5. 套餐积分（由等级表推导，禁止硬编码）
// ═══════════════════════════════════════════════════════════

const PLAN_CREDIT_RATIO_DEFAULT = 1.0

/**
 * 套餐积分 = 稳定期日上限合计 × 有效天数 × 折扣系数。
 *
 * ⚠️ **必须运行时推导**。写死会导致"界面写每日 70 条、套餐却按旧值折算"
 *    这类错误告知，直接成为售后纠纷与举证不利的依据。
 */
function planCreditsFor(validDays, ratio = PLAN_CREDIT_RATIO_DEFAULT) {
  return Math.ceil(stableDailyMaxTotal() * validDays * ratio)
}

/** 半年套餐最低积分（`min_plan_credit`）。 */
function minPlanCredit() {
  return planCreditsFor(180)
}

module.exports = {
  TIER_TABLE,
  MIN_INTERVAL_MS_RANGE,
  ACTIVE_HOURS_DEFAULT,
  CONTENT_SIMILARITY_SEMANTICS,
  TZ_OFFSET_MINUTES,
  MS_PER_DAY,
  PLAN_CREDIT_RATIO_DEFAULT,
  deriveDayIndex,
  tierForDayIndex,
  daysUntilNextTier,
  nextTierName,
  buildPolicy,
  tierTableForClient,
  stableDailyMaxTotal,
  validateClientLimits,
  isActiveHoursShorterOrEqual,
  planCreditsFor,
  minPlanCredit,
}
