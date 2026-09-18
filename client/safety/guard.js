'use strict'

// client/safety/guard.js
//
// 安全护栏 —— **红线 1 在客户端的落地**。
//
// ⚠️ 本模块是客户端**唯一**允许判定"能不能发"的地方。
//    adapters / scheduler 都必须先问它，不得自己判断限额。
//
// 设计原则：**客户端只能更保守**。
//   服务端下发的 policy 是上限；商家可以在客户端调更低，但不能调更高。
//   本模块在任何情况下都不得放宽服务端的限制——即使配置文件被改。
//
// 四道门（全部通过才允许发送）：
//   1. 等级允许发送（观察期 sending_enabled=false → 一律拒绝）
//   2. 当渠道日上限未用尽
//   3. 距上次发送已过最小间隔
//   4. 未处于熔断/急停状态

// ⚠️ 只从 shared/lib 与 client 内部引入。
//    license-server/** 是另一个部署单元，**不得 require**（见 AGENTS.md §3）——
//    时间口径常量因此放在 shared/lib/protocol.js 而非服务端。
const { SOURCE_TYPES, MS_PER_DAY, TZ_OFFSET_MINUTES } = require('../../shared/lib/protocol')

/** 熔断级别。递进：L1 → L2 → L3（停到次日） */
const CIRCUIT_LEVELS = Object.freeze({
  none: 0,
  l1: 1,   // 30 分钟
  l2: 2,   // 1 小时
  l3: 3,   // 停到次日
})

/** 触发熔断的失败归因（命中即计数） */
const CIRCUIT_TRIGGER_REASONS = Object.freeze([
  'risk_control_rejected',
  'account_risk',
  'content_rejected',
  'rate_limited',
])

// ═══════════════════════════════════════════════════════════
// 时间工具（与服务端同一套口径，避免"日"的定义不一致）
// ═══════════════════════════════════════════════════════════

/** 某时刻所属自然日的起点（UTC+8）。与服务端 billing.js 同算法。 */
function dayStartMs(ms, tzOffsetMinutes = TZ_OFFSET_MINUTES) {
  const tzMs = tzOffsetMinutes * 60 * 1000
  return Math.floor((ms + tzMs) / MS_PER_DAY) * MS_PER_DAY - tzMs
}

function isSameDay(a, b) {
  return dayStartMs(a) === dayStartMs(b)
}

/** "HH:MM" → 当日分钟数 */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''))
  if (!m) return null
  const h = Number(m[1]); const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** 判断某时刻是否落在活跃时段内。 */
function isWithinActiveHours(ms, activeHours) {
  const windows = activeHours && activeHours.windows
  if (!Array.isArray(windows) || windows.length === 0) return true // 未配置 = 不限

  const tzOffsetMinutes = activeHours.tz_offset_minutes === undefined
    ? TZ_OFFSET_MINUTES : Number(activeHours.tz_offset_minutes)
  const local = new Date(ms + tzOffsetMinutes * 60 * 1000)
  const nowMin = local.getUTCHours() * 60 + local.getUTCMinutes()

  for (const w of windows) {
    const s = toMinutes(w[0]); const e = toMinutes(w[1])
    if (s === null || e === null || s >= e) continue
    if (nowMin >= s && nowMin < e) return true
  }
  return false
}

// ═══════════════════════════════════════════════════════════
// 护栏
// ═══════════════════════════════════════════════════════════

/**
 * 判定拒绝原因（供审计与界面展示）。
 * @typedef {'sending_disabled'|'daily_cap_exceeded'|'interval_too_short'
 *          |'outside_active_hours'|'circuit_open'|'emergency_stop'
 *          |'credit_exhausted'} DenyReason
 */

class Guard {
  /**
   * @param {object} opts
   * @param {object} opts.store 客户端 Store（读写 runtime-state）
   * @param {object} [opts.now] 取时函数，便于测试注入
   */
  constructor(opts) {
    this.store = opts.store
    this.now = opts.now || (() => Date.now())

    /** 服务端下发的策略。初始为空 —— 未拿到策略前一律拒绝发送。 */
    this.policy = null

    /** 熔断状态 */
    this.circuit = {
      level: 'none',
      untilMs: 0,
      reason: null,
      consecutiveFailures: 0,
      lastFailureAtMs: 0,
    }

    /** 急停开关（商家界面上的一键停止） */
    this.emergencyStop = false
    this.emergencyReason = null

    /** 商家的自定义（只能更保守）。key: `${source}.${field}` */
    this.overrides = {}

    // ⚠️ 必须从盘上恢复状态。否则**重启即可绕过护栏**——
    //    日用量、熔断、急停全丢，商家重开一次程序就能满速发送。
    this.#restore()
  }

  /** 从 runtime-state.json 恢复护栏状态。 */
  #restore() {
    const st = this.store.readJson('runtime-state.json', defaultRuntimeState())
    if (st.circuit && typeof st.circuit === 'object') {
      this.circuit = {
        level: st.circuit.level || 'none',
        untilMs: Number(st.circuit.untilMs || 0),
        reason: st.circuit.reason || null,
        consecutiveFailures: Number(st.circuit.consecutiveFailures || 0),
        lastFailureAtMs: Number(st.circuit.lastFailureAtMs || 0),
      }
    }
    this.emergencyStop = Boolean(st.emergencyStop)
    this.emergencyReason = st.emergencyReason || null
    if (st.overrides && typeof st.overrides === 'object') {
      this.overrides = { ...st.overrides }
    }
  }

  // ── 策略 ──────────────────────────────────────────────────

  /**
   * 采纳服务端下发的策略。
   *
   * ⚠️ **原样采纳或调低**，绝不调高。这里做一个校验：若商家自定义值
   *    比服务端更激进，直接忽略商家的值并记警告——不给"配置写错就放宽"
   *    的机会。
   */
  applyPolicy(policy) {
    if (!policy || typeof policy !== 'object') {
      throw new Error('applyPolicy 需要服务端下发的 policy 对象')
    }
    this.policy = policy

    const conflicts = []
    for (const [key, v] of Object.entries(this.overrides)) {
      const [source, field] = key.split('.')
      const allowed = policy.limits && policy.limits[source]
      if (!allowed) { conflicts.push(key); continue }
      if (!isMoreConservative(field, v, allowed[field])) conflicts.push(key)
    }
    for (const c of conflicts) {
      delete this.overrides[c]
    }
    return { policy_version: policy.policy_version, dropped_overrides: conflicts }
  }

  /** 商家设置自定义（更保守的）值。更激进的值直接拒绝。 */
  setOverride(source, field, value) {
    if (!SOURCE_TYPES.includes(source)) throw new Error(`未知渠道 ${source}`)
    if (!this.policy) throw new Error('尚未采纳服务端策略，不能设置自定义值')

    const allowed = this.policy.limits[source][field]
    if (allowed === undefined) throw new Error(`未知策略字段 ${source}.${field}`)
    if (!isMoreConservative(field, value, allowed)) {
      throw new Error(
        `${source}.${field} = ${value} 比服务端策略更激进（服务端 ${allowed}）。\n` +
        `客户端只能调得更保守——这是为了保护你的账号。`
      )
    }
    this.overrides[`${source}.${field}`] = value
  }

  /** 取某渠道的**实际生效**限额（服务端策略与商家自定义取更保守者）。 */
  effectiveLimits(source) {
    if (!this.policy) return null
    const base = this.policy.limits[source]
    if (!base) return null
    const out = {}
    for (const field of ['daily_max', 'min_interval_ms', 'content_similarity_max']) {
      const ov = this.overrides[`${source}.${field}`]
      out[field] = ov === undefined ? base[field] : moreConservativeOf(field, ov, base[field])
    }
    out.active_hours = this.policy.active_hours
    return out
  }

  /** 是否允许发送（等级层面）。观察期返回 false。 */
  isSendingEnabled() {
    return Boolean(this.policy && this.policy.sending_enabled)
  }

  // ── 急停 ──────────────────────────────────────────────────

  setEmergencyStop(on, reason) {
    this.emergencyStop = Boolean(on)
    this.emergencyReason = on ? (reason || '用户手动急停') : null
    this.#persist()
  }

  // ── 熔断 ──────────────────────────────────────────────────

  /**
   * 记录一次发送结果，必要时升级熔断级别。
   *
   * ⚠️ 递进式（契约与需求规格要求）：
   *    30 分钟 → 1 小时 → 停到次日。旧代码只是 sleep 60 秒继续，
   *    **不足**——风控已经被触发了。
   */
  recordResult({ ok, reason }) {
    const now = this.now()
    const cb = (this.policy && this.policy.circuit_breaker) || {}
    const threshold = Number(cb.platform_reject_threshold || 3)

    if (ok) {
      this.circuit.consecutiveFailures = 0
      return { circuit: this.circuit }
    }

    this.circuit.consecutiveFailures += 1
    this.circuit.lastFailureAtMs = now

    const triggered = CIRCUIT_TRIGGER_REASONS.includes(reason)
    if (!triggered && this.circuit.consecutiveFailures < threshold) {
      this.#persist()
      return { circuit: this.circuit }
    }

    // ⚠️ 每次触发**上升一级**。
    //    到期时用 decayCircuit 下降一级——所以连续触发的级别是
    //    none→l1→l2→l3，下降则 l3→l2→l1→none。
    //    这样"多次触发"与"多次降级"对称，行为可预期。
    const idx = Math.min(CIRCUIT_LEVELS[this.circuit.level] + 1, CIRCUIT_LEVELS.l3)
    const level = idx === 1 ? 'l1' : idx === 2 ? 'l2' : 'l3'
    const cooldown = level === 'l1' ? Number(cb.cooldown_ms || 1800000)
      : level === 'l2' ? Number(cb.cooldown_l2_ms || 3600000)
        : this.#msUntilNextDay(now)

    this.circuit.level = level
    this.circuit.reason = reason || 'consecutive_failures'
    this.circuit.untilMs = now + cooldown
    this.circuit.consecutiveFailures = 0 // 已触发熔断，计数归零重新计
    this.#persist()

    return {
      circuit: this.circuit,
      escalated: true,
      cooldown_ms: cooldown,
      level,
      hint: level === 'l1' ? '已暂停 30 分钟'
        : level === 'l2' ? '已暂停 1 小时'
          : '今日已停止发送（明天恢复）',
    }
  }

  /**
   * 熔断是否生效中。
   *
   * ⚠️ 本方法是**纯查询，不改状态**。
   *    早期实现会在查询时隐式降级级别（到期就降一级），导致
   *    `canSend()` 这类只读调用产生副作用——同一秒内调用两次
   *    可能得到不同的熔断级别，排查问题时极难定位。
   *    降级改为显式方法 `decayCircuit()`，由调度器在冷却到期后调用。
   */
  isCircuitOpen(atMs) {
    if (this.circuit.level === 'none') return false
    const now = atMs === undefined ? this.now() : atMs
    return now < this.circuit.untilMs
  }

  /**
   * 冷却到期后降一级。
   *
   * ⚠️ 降级而**不是直接清零**：清了就等于立刻恢复满速，
   *    而风控刚刚才触发过。递进降级给账号适应时间。
   *
   * @returns {boolean} 是否发生了降级
   */
  decayCircuit(atMs) {
    if (this.circuit.level === 'none') return false
    const now = atMs === undefined ? this.now() : atMs
    if (now < this.circuit.untilMs) return false

    const cur = CIRCUIT_LEVELS[this.circuit.level]
    const next = Math.max(0, cur - 1)
    this.circuit.level = next === 0 ? 'none' : next === 1 ? 'l1' : 'l2'
    this.circuit.untilMs = 0
    this.circuit.consecutiveFailures = 0
    this.#persist()
    return true
  }

  /** 手动清除熔断（商家处理完验证码后）。 */
  clearCircuit() {
    this.circuit = { level: 'none', untilMs: 0, reason: null, consecutiveFailures: 0, lastFailureAtMs: 0 }
    this.#persist()
  }

  // ── 核心判定 ──────────────────────────────────────────────

  /**
   * 能否发送一条。
   *
   * ⚠️ 这是**唯一**的准入判定。任何发送路径都必须先问它。
   *
   * @param {object} p
   * @param {string} p.sourceType comment | live_danmaku | dm
   * @param {number} [p.atMs] 判定时刻（默认 now）
   * @returns {{allow: boolean, reason?: DenyReason, detail?: object}}
   */
  canSend({ sourceType, atMs }) {
    const now = atMs === undefined ? this.now() : atMs

    // 0. 尚未拿到策略 → 一律拒绝。
    //    ⚠️ 这是刻意的 fail-closed：没有服务端策略就没有依据，
    //    "先跑起来再说"会让客户端在无护栏状态下发送。
    if (!this.policy) {
      return { allow: false, reason: 'policy_missing', detail: { hint: '尚未从服务端取得策略，已暂停发送' } }
    }

    // 1. 急停
    if (this.emergencyStop) {
      return { allow: false, reason: 'emergency_stop', detail: { hint: this.emergencyReason } }
    }

    // 2. 观察期/禁发
    if (!this.policy.sending_enabled) {
      return {
        allow: false,
        reason: 'sending_disabled',
        detail: {
          account_tier: this.policy.account_tier,
          next_tier: this.policy.next_tier,
          days_until_next_tier: this.policy.days_until_next_tier,
          hint: `当前处于${tierLabel(this.policy.account_tier)}，仅采集不发送`,
        },
      }
    }

    // 3. 熔断
    if (this.isCircuitOpen(now)) {
      return {
        allow: false,
        reason: 'circuit_open',
        detail: {
          level: this.circuit.level,
          until_ms: this.circuit.untilMs,
          remaining_ms: this.circuit.untilMs - now,
          reason: this.circuit.reason,
        },
      }
    }

    const limits = this.effectiveLimits(sourceType)
    if (!limits) {
      return { allow: false, reason: 'unknown_source', detail: { source_type: sourceType } }
    }

    // 4. 活跃时段
    if (!isWithinActiveHours(now, limits.active_hours)) {
      return {
        allow: false,
        reason: 'outside_active_hours',
        detail: { windows: limits.active_hours.windows, hint: '当前不在活跃时段，已暂停发送' },
      }
    }

    // 5. 日上限
    const used = this.usedToday(sourceType, now)
    if (limits.daily_max <= 0 || used >= limits.daily_max) {
      return {
        allow: false,
        reason: 'daily_cap_exceeded',
        detail: { used, max: limits.daily_max, source_type: sourceType },
      }
    }

    // 6. 最小间隔
    const last = this.lastSentAt(sourceType)
    if (last && now - last < limits.min_interval_ms) {
      return {
        allow: false,
        reason: 'interval_too_short',
        detail: {
          elapsed_ms: now - last,
          required_ms: limits.min_interval_ms,
          wait_ms: limits.min_interval_ms - (now - last),
        },
      }
    }

    return { allow: true, detail: { used, max: limits.daily_max, remaining: limits.daily_max - used } }
  }

  /**
   * 记一次成功发送，用于日上限与间隔计算。
   *
   * ⚠️ 必须落盘（走 store.update 的读-改-写），否则进程重启后
   *    日上限会被重置，等于护栏失效。
   */
  recordSent({ sourceType, atMs }) {
    const now = atMs === undefined ? this.now() : atMs
    this.store.update('runtime-state.json', defaultRuntimeState(), (state) => {
      const day = dayStartMs(now)
      if (state.dayStartMs !== day) {
        state.dayStartMs = day
        state.usedBySource = {}
      }
      state.usedBySource = state.usedBySource || {}
      state.usedBySource[sourceType] = (state.usedBySource[sourceType] || 0) + 1
      state.lastSentAtMs = state.lastSentAtMs || {}
      state.lastSentAtMs[sourceType] = now
      state.updatedAtMs = now
      return state
    })
  }

  /** 当日某渠道已发送条数。跨日自动归零（不改盘，读取时判断）。 */
  usedToday(sourceType, atMs) {
    const now = atMs === undefined ? this.now() : atMs
    const st = this.store.readJson('runtime-state.json', defaultRuntimeState())
    if (dayStartMs(now) !== st.dayStartMs) return 0
    return Number((st.usedBySource && st.usedBySource[sourceType]) || 0)
  }

  lastSentAt(sourceType) {
    const st = this.store.readJson('runtime-state.json', defaultRuntimeState())
    const v = st.lastSentAtMs && st.lastSentAtMs[sourceType]
    return v ? Number(v) : null
  }

  /** 快照，供界面展示与审计记录。 */
  snapshot() {
    const out = {
      sending_enabled: this.isSendingEnabled(),
      emergency_stop: this.emergencyStop,
      circuit: { ...this.circuit },
      policy_version: this.policy ? this.policy.policy_version : null,
      account_tier: this.policy ? this.policy.account_tier : null,
      used: {},
      limits: {},
    }
    if (this.policy) {
      for (const s of SOURCE_TYPES) {
        const l = this.effectiveLimits(s)
        out.limits[s] = { daily_max: l.daily_max, min_interval_ms: l.min_interval_ms }
        out.used[s] = this.usedToday(s)
      }
    }
    return out
  }

  #msUntilNextDay(now) {
    return dayStartMs(now) + MS_PER_DAY - now
  }

  #persist() {
    try {
      this.store.update('runtime-state.json', defaultRuntimeState(), (state) => {
        state.circuit = { ...this.circuit }
        state.emergencyStop = this.emergencyStop
        state.emergencyReason = this.emergencyReason
        state.overrides = { ...this.overrides }
        state.updatedAtMs = this.now()
        return state
      })
    } catch (e) {
      // ⚠️ 不吞异常。护栏状态写不进盘意味着重启后护栏失效，
      //    是必须暴露的问题。
      throw new Error(`保存护栏状态失败（重启后熔断/急停可能丢失）：${e.message}`)
    }
  }
}

function defaultRuntimeState() {
  return {
    dayStartMs: dayStartMs(Date.now()),
    usedBySource: {},
    lastSentAtMs: {},
    circuit: { level: 'none', untilMs: 0, reason: null, consecutiveFailures: 0, lastFailureAtMs: 0 },
    emergencyStop: false,
    emergencyReason: null,
    overrides: {},
    updatedAtMs: 0,
  }
}

/**
 * 判断 value 是否"不比 allowed 更激进"。
 *
 * ⚠️ ⚠️ 四个方向必须分别判断，**最容易弄反的是 content_similarity_max**：
 *   · daily_max              越小越保守
 *   · min_interval_ms        越大越保守
 *   · content_similarity_max **越小越保守**（阈值低 = 更容易拒绝 = 更严格）
 */
function isMoreConservative(field, value, allowed) {
  if (value === undefined || value === null) return true
  switch (field) {
    case 'daily_max': return Number(value) <= Number(allowed)
    case 'min_interval_ms': return Number(value) >= Number(allowed)
    case 'content_similarity_max': return Number(value) <= Number(allowed)
    default: return false // 未知字段一律视为不保守，拒绝
  }
}

/** 取两者中更保守的那个。 */
function moreConservativeOf(field, a, b) {
  switch (field) {
    case 'daily_max': return Math.min(Number(a), Number(b))
    case 'min_interval_ms': return Math.max(Number(a), Number(b))
    case 'content_similarity_max': return Math.min(Number(a), Number(b))
    default: return b
  }
}

function tierLabel(tier) {
  return {
    observation: '观察期',
    warm_up: '预热期',
    ramp_up: '爬坡期',
    stable: '稳定期',
  }[tier] || tier
}

module.exports = {
  Guard,
  CIRCUIT_LEVELS,
  CIRCUIT_TRIGGER_REASONS,
  dayStartMs,
  isSameDay,
  isWithinActiveHours,
  toMinutes,
  isMoreConservative,
  moreConservativeOf,
  tierLabel,
  defaultRuntimeState,
}