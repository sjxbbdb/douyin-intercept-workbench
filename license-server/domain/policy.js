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

/**
 * 把**账号级覆盖**合并进等级基准策略，得到实际生效的策略。
 *
 * ⚠️ 这个函数补的是一个真实的功能缺口：CLI 的 `policy set` 会把账号级覆盖
 *    写进 `policy.policy_json`，并写 `policy_history`、自增版本号 —— 但
 *    `buildPolicy()` 只按等级表推导、**不读覆盖**，于是运维以为
 *    "我给这家商户收紧了限额"，客户端拿到的还是等级基准值。
 *    一个"看起来生效、实际什么都没发生"的开关，比没有这个命令更糟：
 *    它让人以为已经处理过了，出事时才发现当时根本没收紧。
 *
 * ⚠️ 合并方向**只能更保守**（红线 1）。四个方向分别处理，最容易弄反的
 *    仍是 `content_similarity_max`（**越小越保守**）。这里的方向判据必须与
 *    `validateClientLimits` 一致 —— 两处相反的话，服务端会下发一个
 *    自己的校验器都不接受的值，客户端每次心跳都会被判越权。
 *
 * ⚠️ `sending_enabled` / `collect_only` **不可被账号级覆盖放宽**。
 *    它们由等级表按天数推导（观察期禁发是产品前提），本函数不碰它们。
 *
 * @param {object} base          `buildPolicy()` 的输出
 * @param {object|null} override 从 `policy.policy_json` 读出的覆盖层
 * @returns {object} 合并后的策略；`policy_hash` 按合并结果重算
 */
function mergePolicyOverride(base, override) {
  if (!override || typeof override !== 'object') return base

  const out = JSON.parse(JSON.stringify(base))
  let changed = false

  // ── 三渠道限额 ──────────────────────────────────────────
  if (override.limits && typeof override.limits === 'object') {
    for (const src of SOURCE_TYPES) {
      const o = override.limits[src]
      if (!o || typeof o !== 'object') continue
      const cur = out.limits[src]
      if (!cur) continue

      if (Number.isFinite(Number(o.daily_max))) {
        const v = Math.min(Number(cur.daily_max), Math.max(0, Math.floor(Number(o.daily_max))))
        if (v !== cur.daily_max) { cur.daily_max = v; changed = true }
      }
      if (Number.isFinite(Number(o.min_interval_ms))) {
        // ⚠️ 上界仍受 `min_interval_ms_range` 约束：覆盖可以拉长间隔，
        //    但不能超过契约允许的区间上限 —— 否则客户端 ack 会被
        //    `validateClientLimits` 拒掉，表现为"策略下发后心跳一直失败"。
        const lo = Number(cur.min_interval_ms)
        const hi = MIN_INTERVAL_MS_RANGE[src][1]
        const v = Math.max(lo, Math.min(hi, Math.floor(Number(o.min_interval_ms))))
        if (v !== cur.min_interval_ms) { cur.min_interval_ms = v; changed = true }
      }
      if (Number.isFinite(Number(o.content_similarity_max))) {
        const v = Math.min(Number(cur.content_similarity_max), Number(o.content_similarity_max))
        if (v !== cur.content_similarity_max) { cur.content_similarity_max = v; changed = true }
      }
    }
  }

  // ── 活跃时段：只能调短（取交集），不得延长或新增窗口 ────
  if (override.active_hours && Array.isArray(override.active_hours.windows)) {
    const merged = intersectWindowSets(out.active_hours.windows, override.active_hours.windows)
    if (merged) {
      const same = JSON.stringify(merged) === JSON.stringify(out.active_hours.windows)
      if (!same) {
        out.active_hours = {
          tz_offset_minutes: out.active_hours.tz_offset_minutes,
          windows: merged,
        }
        changed = true
      }
    }
  }

  // ── 熔断参数：只能更严（阈值调低 / 冷却调长）─────────────
  if (override.circuit_breaker && typeof override.circuit_breaker === 'object') {
    const cb = out.circuit_breaker
    const o = override.circuit_breaker
    const lower = (k) => {
      if (!Number.isFinite(Number(o[k]))) return
      const v = Math.min(Number(cb[k]), Number(o[k]))
      if (v !== cb[k]) { cb[k] = v; changed = true }
    }
    const higher = (k) => {
      if (!Number.isFinite(Number(o[k]))) return
      const v = Math.max(Number(cb[k]), Number(o[k]))
      if (v !== cb[k]) { cb[k] = v; changed = true }
    }
    lower('failure_rate_threshold')
    lower('failure_rate_window')
    lower('platform_reject_threshold')
    higher('cooldown_ms')
    higher('cooldown_l2_ms')
    higher('risk_code_cooldown_ms')
  }

  // ── 空闲停扣：只能调短（越早停越保守）──────────────────
  if (Number.isFinite(Number(override.idle_pause_ms))) {
    const v = Math.min(Number(out.idle_pause_ms), Math.max(0, Number(override.idle_pause_ms)))
    if (v !== out.idle_pause_ms) { out.idle_pause_ms = v; changed = true }
  }

  if (!changed) return base

  // ⚠️ 内容变了就必须**重算 policy_hash**：客户端在心跳里 ack 这个哈希，
  //    服务端用它写 `policy_ack_log` 存证。不重算的话"生效值变了但哈希没变"
  //    会让审计无法区分两个不同的策略 —— 而红线 3 要的恰恰是
  //    "当时**实际生效**的是哪一份"。
  const hashable = { ...out }
  delete hashable.policy_hash
  delete hashable.account_id
  delete hashable.generated_at_ms
  const policy_hash = crypto.createHash('sha256')
    .update(stableStringify(hashable), 'utf8').digest('hex').slice(0, 16)
  return { ...out, policy_hash }
}

/**
 * 两个活跃时段窗口集合求交集。
 *
 * ⚠️ 返回 `[]` 表示"交集为空"，即该商户**全天都不能发**。这不是错误，
 *    是合法的收紧结果（例如运维把窗口缩到与基准不重叠的时段）。
 *    照常下发即可：客户端会因 `active_hours` 不通过而停发，
 *    而护栏的 `outside_active_hours` 归因能让运维一眼看出原因。
 *
 * ⚠️ 输出必须**稳定排序 + 去重**，否则同一份覆盖每次算出的 JSON 不同，
 *    `policy_hash` 就会抖动，客户端会以为策略一直在变、
 *    每次心跳都触发一次"策略切换"。
 */
function intersectWindowSets(baseWindows, overrideWindows) {
  const base = (baseWindows || []).map(parseWindow).filter(Boolean)
  const ov = (overrideWindows || []).map(parseWindow).filter(Boolean)
  if (!base.length) return []
  if (!ov.length) return []

  const seen = new Set()
  for (const [bs, be] of base) {
    for (const [os, oe] of ov) {
      const s = Math.max(bs, os)
      const e = Math.min(be, oe)
      if (s < e) seen.add(`${s}-${e}`)
    }
  }
  return [...seen]
    .map((k) => k.split('-').map(Number))
    .sort((a, b) => a[0] - b[0])
    .map(([s, e]) => [minutesToHHMM(s), minutesToHHMM(e)])
}

/** "HH:MM" → 当日分钟数；非法返回 null。 */
function parseWindow(w) {
  const a = hhmmToMinutes(w && w[0])
  const b = hhmmToMinutes(w && w[1])
  if (a === null || b === null || a >= b) return null
  return [a, b]
}

function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''))
  if (!m) return null
  const h = Number(m[1]); const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

function minutesToHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

/**
 * 读取账号级覆盖并合并，得到**实际会下发给客户端的**策略。
 *
 * ⚠️ 这是所有下发路径（登录、续期、心跳、`GET /policy/current`）都该走的
 *    入口。直接调 `buildPolicy()` 会绕过账号级覆盖 —— 而那条路径正是
 *    "`policy set` 写了但不下发"这个缺口的来源，所以这里做成唯一入口。
 *
 * ⚠️ 覆盖是**每请求都要读一次**的东西（心跳 60 秒一次）。为了不让它
 *    变成热路径上的额外查询，这里带一个**按 (accountId, version) 缓存**：
 *    覆盖只在 `policy set` 时改变，而那一定伴随 `policy_version` 自增，
 *    所以版本号就是天然的失效键 —— 不会读到陈旧值。
 *
 * @param {object} db
 * @param {object} p `{ accountId, accountDayIndex, policyVersion, nowMs }`
 */
function buildEffectivePolicy(db, p) {
  const base = buildPolicy(p)
  if (!db || p.accountId === undefined || p.accountId === null) return base

  const cacheKey = `${p.accountId}:${p.policyVersion}`
  let override
  if (OVERRIDE_CACHE.has(cacheKey)) {
    override = OVERRIDE_CACHE.get(cacheKey)
  } else {
    override = null
    try {
      const row = db.prepare(
        'SELECT policy_json FROM policy WHERE account_id = ? AND policy_version = ?'
      ).get(p.accountId, p.policyVersion)
      if (row && row.policy_json) override = safeParseJson(row.policy_json)
    } catch (e) {
      // ⚠️ 读不到覆盖**不能**让策略下发失败：宁可下发等级基准值
      //    （更宽松但合法），也不要让商家因为一次查询异常而无法登录。
      //    但必须留痕 —— 静默忽略会让"覆盖不生效"永远查不出来。
      warnOverrideReadFailed(e, cacheKey)
    }
    // 缓存 null 也是有效的（说明该账号此刻没有覆盖），避免每请求都查一次库
    if (OVERRIDE_CACHE.size >= OVERRIDE_CACHE_MAX) OVERRIDE_CACHE.clear()
    OVERRIDE_CACHE.set(cacheKey, override)
  }

  return mergePolicyOverride(base, override)
}

/** 覆盖缓存：键 `accountId:version`。版本自增即天然失效，无需 TTL。 */
const OVERRIDE_CACHE = new Map()
const OVERRIDE_CACHE_MAX = 500

let overrideWarnHook = null
/** 注册"读覆盖失败"的告警钩子（由 server 装配时注入 logger）。 */
function setOverrideWarnHook(fn) { overrideWarnHook = typeof fn === 'function' ? fn : null }

function warnOverrideReadFailed(e, key) {
  if (overrideWarnHook) {
    try { overrideWarnHook({ event: 'policy_override_read_failed', key, message: e && e.message }) } catch (hookErr) {
      // 钩子本身抛错不能影响策略下发。
      process.stderr.write(`[policy] 告警钩子抛错：${hookErr && hookErr.message}\n`)
    }
    return
  }
  process.stderr.write(`[policy] 读取账号级覆盖失败（${key}）：${e && e.message}；已退回等级基准值\n`)
}

function safeParseJson(s) {
  try { return JSON.parse(s) } catch (e) { return null }
}

/** 清空覆盖缓存（`policy set` 之后调用；正常靠版本号失效，这是兜底）。 */
function clearOverrideCache() { OVERRIDE_CACHE.clear() }

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
  buildEffectivePolicy,
  mergePolicyOverride,
  intersectWindowSets,
  setOverrideWarnHook,
  clearOverrideCache,
  tierTableForClient,
  stableDailyMaxTotal,
  validateClientLimits,
  isActiveHoursShorterOrEqual,
  planCreditsFor,
  minPlanCredit,
}
