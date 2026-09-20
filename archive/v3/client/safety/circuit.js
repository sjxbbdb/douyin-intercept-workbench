'use strict'

// client/safety/circuit.js
//
// 熔断状态机 —— 三级递进 L1(30 分钟) → L2(1 小时) → L3(停到次日 00:00 UTC+8)。
//
// ⚠️ 为什么需要它（旧代码的教训）：
//     旧实现被风控打回后只 `sleep(60)` 就继续发。风控已经被触发，
//     60 秒后继续等于告诉平台"这是一个不知疲倦的脚本"，账号很快就被封。
//     验收标准 17 明确要求退避必须是 **30 分钟级**。
//
// ⚠️ 本模块**不可能被关闭**（红线）：
//     **不提供任何禁用开关、环境变量、构造参数或配置项**。
//     急停与熔断不得被关闭、不得被移除（AGENTS.md §1 / 方案 §4.5）。
//     本文件里不存在 `enabled` / `disabled` / `off` 之类的开关。
//     需要临时放行只有一条路径：`clear()`——一次显式、可审计的人工动作。
//
// ⚠️⚠️ 两条最容易写错、后果最严重的规则：
//
//   1. **服务端冷却时长是权威下限，只能取更长**。
//      服务端下发 `cooldown_until_ms` 时：
//          untilMs = max(本地递进算出的到期时刻, 服务端给的到期时刻)
//      绝不允许因为它比本地短就把本地级别/时长降下来。
//      写反（直接采纳服务端值）会让"服务端给 5 分钟、本地已判 L2(1 小时)"
//      退回 5 分钟——本地递进被服务端削弱，风控冷却凭空缩短。
//
//   2. **isOpen() 是纯查询**。
//      早期实现会在查询时隐式降级，导致 `canSend()` 这类只读调用产生副作用：
//      同一秒内调用两次可能得到不同级别，排查问题时无从复现。
//      降级只能由显式的 `decay()` 触发。guard.js 里有同样的注释与同样的理由。
//
// ⚠️ 与 guard.js 里那份"简化熔断"的关系（两者并存，**更保守者胜**）：
//     · `guard.circuit` 是**遗留简化路径**：只有 level/untilMs/reason，由
//       `Guard.recordResult()` 驱动，服务平台风控拒绝那条链路。**本模块不删改它。**
//     · 本模块是**完整状态机**：多触发源（验证码/滑块、连续失败、平台拒绝计数、
//       失败率窗口）、服务端冷却下限、可持久化的失败窗口。
//     · 所以本模块提供 `guardCircuit(guard)` —— 返回两者**真正的合并视图**
//       （级别取大、到期取大、任一 open 即为 open），供调度器/UI 使用；
//       另提供 `applyToGuard(guard)` 把合并结果**推进** guard，使 guard.canSend()
//       也能看到完整状态机的判定。两者都只允许收紧，绝不放宽。

// ⚠️ 只从 shared/lib 与 client 内部引入（见 AGENTS.md §3：客户端不得 require 服务端）。
const {
  CIRCUIT_LEVELS, CIRCUIT_TRIGGER_REASONS, dayStartMs, defaultRuntimeState,
} = require('./guard')
const { MS_PER_DAY } = require('../../shared/lib/protocol')

/**
 * 三级熔断的默认冷却时长（毫秒）。
 *
 * ⚠️ 这三个数是**需求规格 FR-2.3.5 规定的梯度定义**（30 分钟 / 1 小时 / 停到次日），
 *    不是"限额"：它们不限制发多少条，只决定被打回后停多久。
 *    运行时优先取服务端 policy.circuit_breaker 的 cooldown_ms / cooldown_l2_ms /
 *    risk_code_cooldown_ms；仅当还没拿到策略时用这里的定义兜底
 *    （兜底方向是**更保守**，所以安全）。
 */
const L1_COOLDOWN_MS = 1800000 // 30 分钟
const L2_COOLDOWN_MS = 3600000 // 1 小时
// L3 没有固定毫秒数：一律停到下一个 00:00(UTC+8)，见 msUntilNextDay()。

/** 触发"升级一级"的风控类失败归因。转发自 guard.js —— 闭集只有一份定义。 */
const TRIGGER_REASONS = CIRCUIT_TRIGGER_REASONS

/** 验证码 / 滑块：命中即视为风控已触发（最直接的真人校验信号）。 */
const CAPTCHA_REASONS = Object.freeze([
  'captcha', 'slider', 'captcha_appeared', 'slider_appeared',
])

/** 熔断状态在 runtime-state.json 中的键名。⚠️ 与 guard 的字段并存，不覆盖。 */
const STATE_KEY = 'circuitState'

/** 失败率窗口数组的长度上限（防止损坏文件把内存打爆）。 */
const MAX_WINDOW_HARD_CAP = 500

/** 兜底阈值：仅在尚未拿到服务端策略时使用。 */
const FALLBACK = Object.freeze({
  failure_rate_threshold: 0.4,
  failure_rate_window: 20,
  platform_reject_threshold: 3,
})

/** 级别名 ↔ 序号 */
const LEVEL_NAMES = Object.freeze(['none', 'l1', 'l2', 'l3'])

class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {object} opts.store 客户端 Store（唯一写盘者）
   * @param {() => number} [opts.now] 取时函数，便于测试注入
   */
  constructor(opts) {
    if (!opts || !opts.store) throw new Error('CircuitBreaker 需要 store')
    this.store = opts.store
    this.now = opts.now || (() => Date.now())
    /** 服务端下发的 policy（提供 circuit_breaker 阈值与冷却时长） */
    this.policy = null
    this.state = defaultState(this.now())
    this.#restore()
  }

  // ── 策略 ──────────────────────────────────────────────────

  /**
   * 采纳服务端策略。
   *
   * ⚠️ 这里**刻意不用** guard.js 的 `isMoreConservative` / `moreConservativeOf`：
   *    那两个函数是为四个**策略限额字段名**（daily_max / min_interval_ms /
   *    content_similarity_max）写死的，未知字段名一律返回"不保守 / 取 b"。
   *    拿它判断 `failure_rate_threshold` 会**静默**变成"服务端永远赢"，
   *    服务端若下发一个比兜底更激进的阈值（例如 0.9）就会被直接采纳。
   *    所以本节对每个阈值单独写明方向。
   */
  applyPolicy(policy) {
    if (!policy || typeof policy !== 'object') {
      throw new Error('CircuitBreaker.applyPolicy 需要服务端下发的 policy 对象')
    }
    this.policy = policy
    return this.#cbConfig()
  }

  /**
   * 有效配置。
   *
   * 方向约定（每个字段都要单独想清楚，别套用同一个 min/max）：
   *   · failure_rate_threshold    **越低越保守** → 与兜底取 min
   *   · failure_rate_window       采样口径，不是松紧 → 服务端说了算
   *   · platform_reject_threshold **越低越保守** → 与兜底取 min
   *   · cooldown_ms / l2 / risk   停多久，**越长越保守** → 与兜底取 max
   */
  #cbConfig() {
    const cb = (this.policy && this.policy.circuit_breaker) || {}
    const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
    return {
      failure_rate_threshold: Math.min(
        num(cb.failure_rate_threshold, FALLBACK.failure_rate_threshold),
        FALLBACK.failure_rate_threshold
      ),
      failure_rate_window: Math.max(2, Math.min(
        MAX_WINDOW_HARD_CAP, Math.floor(num(cb.failure_rate_window, FALLBACK.failure_rate_window))
      )),
      platform_reject_threshold: Math.max(1, Math.min(
        Math.floor(num(cb.platform_reject_threshold, FALLBACK.platform_reject_threshold)),
        FALLBACK.platform_reject_threshold
      )),
      l1_cooldown_ms: Math.max(num(cb.cooldown_ms, L1_COOLDOWN_MS), L1_COOLDOWN_MS),
      l2_cooldown_ms: Math.max(num(cb.cooldown_l2_ms, L2_COOLDOWN_MS), L2_COOLDOWN_MS),
    }
  }

  // ── 记录结果 ──────────────────────────────────────────────

  /** 一次成功：清零"连续失败"计数，但**不动**已在生效的熔断。 */
  recordSuccess(atMs) {
    const now = this._at(atMs)
    this.state.consecutiveFailures = 0
    this.state.platformRejectCount = 0
    this.state.lastOutcomeAtMs = now
    this.#pushOutcome(true)
    this.#persist()
    return this.snapshot(now)
  }

  /**
   * 一次失败。
   *
   * 触发规则（任一命中即升级一级）：
   *   · `reason` 命中风控归因闭集（risk_control_rejected / account_risk /
   *     content_rejected / rate_limited）
   *   · `reason` 是验证码 / 滑块
   *   · 连续失败数达到 platform_reject_threshold
   *   · 失败率（最近 failure_rate_window 条）超过 failure_rate_threshold
   *
   * @param {string} reason 归因码（闭集见 guard.js 的 CIRCUIT_TRIGGER_REASONS）
   * @param {object} [opts] {atMs}
   */
  recordFailure(reason, opts = {}) {
    const now = this._at(opts.atMs)
    this.state.consecutiveFailures += 1
    this.state.lastFailureAtMs = now
    this.state.lastOutcomeAtMs = now
    this.state.lastReason = reason || 'unknown'
    this.#pushOutcome(false)

    const cfg = this.#cbConfig()
    const riskTrigger = TRIGGER_REASONS.includes(reason)
    const captcha = CAPTCHA_REASONS.includes(reason)
    const consecutive = this.state.consecutiveFailures >= cfg.platform_reject_threshold
    const rate = this.#failureRate()
    const rateTrigger = this.#windowSize() >= cfg.failure_rate_window &&
      rate > cfg.failure_rate_threshold

    if (!riskTrigger && !captcha && !consecutive && !rateTrigger) {
      this.#persist()
      return this.snapshot(now)
    }

    const trigger = captcha ? 'captcha'
      : riskTrigger ? reason
        : consecutive ? 'consecutive_failures'
          : 'failure_rate'
    return this.#escalate(trigger, now, { failure_rate: rate, window: this.#windowSize() })
  }

  /**
   * 平台风控拒绝计数（协议 §7.1：`platform_reject_count` 达阈值触发熔断）。
   *
   * ⚠️ 按"**计数**"语义实现：每调一次 +1，与 recordFailure 的窗口语义分开。
   *    调用方在处理 `verdict=failed` + `risk_control_signal=empty_response` 时调它。
   *
   * @param {string} [reason]
   * @param {object} [opts] {atMs}
   */
  recordPlatformReject(reason, opts = {}) {
    const now = this._at(opts.atMs)
    this.state.platformRejectCount += 1
    this.state.lastOutcomeAtMs = now
    this.state.lastReason = reason || 'risk_control_rejected'
    this.#pushOutcome(false)

    const cfg = this.#cbConfig()
    if (this.state.platformRejectCount >= cfg.platform_reject_threshold) {
      return this.#escalate('platform_reject_count', now, {
        platform_reject_count: this.state.platformRejectCount,
        threshold: cfg.platform_reject_threshold,
      })
    }
    this.#persist()
    return this.snapshot(now)
  }

  /**
   * 单独检查失败率（调度器可周期性调用）。
   *
   * ⚠️ 与 recordFailure 内部的失败率判定**共用同一份窗口与阈值**，
   *    不会因为窗口未满就误触发。
   *
   * @param {object} [opts] {atMs}
   */
  recordFailureRate(opts = {}) {
    const now = this._at(opts.atMs)
    const cfg = this.#cbConfig()
    const rate = this.#failureRate()
    const size = this.#windowSize()

    if (size < cfg.failure_rate_window || !(rate > cfg.failure_rate_threshold)) {
      return { escalated: false, failure_rate: rate, window: size, snapshot: this.snapshot(now) }
    }
    const snap = this.#escalate('failure_rate', now, { failure_rate: rate, window: size })
    return { escalated: true, failure_rate: rate, window: size, snapshot: snap }
  }

  // ── 服务端冷却 ────────────────────────────────────────────

  /**
   * 服务端下发冷却截止时刻（`circuit_break` 命令或心跳 `circuit_breaker`）。
   *
   * ⚠️⚠️ **取较长者**：服务端值是权威**下限**。
   *
   *        untilMs = max(当前到期时刻, 服务端 untilMs, now + 本地级别最低冷却时长)
   *
   *     最后一项保证"本地已判 L2(1 小时)，服务端只给 5 分钟"时
   *     **本地级别不被削弱**——这正是方案 §4.5 与 §8 裁定 15 的要求。
   *     反过来（直接采纳服务端值）会让本地递进形同虚设。
   *
   * @param {number} untilMs 服务端给的冷却截止时刻（Unix 毫秒）
   * @param {string} [reason]
   * @param {object} [opts] {atMs}
   */
  applyServerCooldown(untilMs, reason, opts = {}) {
    const now = this._at(opts.atMs)
    const server = Number(untilMs)
    if (!Number.isFinite(server) || server <= 0) {
      throw new Error(`applyServerCooldown 需要合法的 cooldown_until_ms，收到 ${untilMs}`)
    }

    const cfg = this.#cbConfig()
    const localBefore = this.state.untilMs
    const openBefore = localBefore > now

    // 服务端要求熔断 → 本地至少要有 L1 级别的持续时长：
    // 本地已开冷却时不得压缩它；本地未开时按"至少 L1"起算。
    const localMinUntil = openBefore ? localBefore : now + cfg.l1_cooldown_ms
    const merged = Math.max(localMinUntil, server)

    this.state.level = Math.max(this.state.level, 1)
    this.state.lastLevel = Math.max(this.state.lastLevel, this.state.level)
    this.state.untilMs = merged
    this.state.reason = reason || this.state.reason || 'server_circuit_break'
    this.state.source = 'server'
    this.state.openedAtMs = openBefore ? this.state.openedAtMs : now
    this.state.consecutiveFailures = 0
    this.#persist()

    return {
      level: LEVEL_NAMES[this.state.level],
      untilMs: merged,
      localMinUntilMs: localMinUntil,
      serverUntilMs: server,
      // ⚠️ 明确回报"服务端时长是否被本地级别顶上去"，便于审计与排障
      server_shorter_than_local: server < localMinUntil,
    }
  }

  /**
   * 把一个"服务端说熔断中"的心跳对象直接喂进来。
   *
   * ⚠️ **服务端说"没熔断"时什么都不做**——绝不因为服务端说 `open:false`
   *    就清掉本地熔断。服务端看到的是**已上报**的明细，本地可能刚被
   *    验证码打断但还没来得及上报；此时清除本地熔断等于自己把门打开。
   *
   * @param {{open?:boolean, cooldown_until_ms?:number, trigger?:string}} info
   * @param {object} [opts] {atMs}
   */
  applyServerState(info, opts = {}) {
    if (!info || typeof info !== 'object') {
      return { applied: false, reason: 'no_server_state' }
    }
    const open = info.open === true
    const until = Number(info.cooldown_until_ms || 0)
    if (!open || !Number.isFinite(until) || until <= 0) {
      return { applied: false, reason: 'server_reports_closed_ignored' }
    }
    return {
      applied: true,
      ...this.applyServerCooldown(until, info.trigger || 'server_heartbeat', opts),
    }
  }

  // ── 查询（全部纯函数，无副作用） ───────────────────────────

  /**
   * 熔断是否生效中。
   *
   * ⚠️ **纯查询**：不降级、不落盘、不改任何字段。
   *    连续调用任意多次结果完全一致（测试里有专门用例）。
   *
   * @param {number} [atMs]
   * @returns {boolean}
   */
  isOpen(atMs) {
    if (this.state.level <= 0 && this.state.untilMs <= 0) return false
    const now = this._at(atMs)
    return now < this.state.untilMs
  }

  /**
   * 冷却到期后的**显式**降级：级别 −1，并关闭本次冷却。
   *
   * ⚠️ 降一级而不是清零：清零等于立刻恢复满速，而风控刚刚才触发过。
   *    递进降级给账号适应时间（与 guard.js 的语义保持一致）。
   *
   * ⚠️ **服务端下限在到期前不得被本地 decay 突破**：
   *    `max(本地 untilMs, 服务端给过的最大截止时刻)` 之前一律返回 false。
   *
   * @param {number} [atMs]
   * @returns {boolean} 是否发生了降级
   */
  decay(atMs) {
    if (this.state.level <= 0) return false
    const now = this._at(atMs)
    const hardUntil = Math.max(this.state.untilMs, this.state.serverFloorMs)
    if (now < hardUntil) return false

    this.state.level = Math.max(0, this.state.level - 1)
    this.state.untilMs = 0
    this.state.consecutiveFailures = 0
    this.state.platformRejectCount = 0
    this.state.reason = null
    this.state.source = null
    this.state.openedAtMs = 0
    this.#persist()
    return true
  }

  /**
   * 手动清除（商家处理完验证码之后）。
   *
   * ⚠️ 这是**唯一的**解除路径，且是一次显式动作——本模块没有任何
   *    自动关闭或禁用开关（红线）。调用方必须记审计（audit.js 的 circuit 条目）。
   */
  clear(atMs) {
    this.state = defaultState(this._at(atMs))
    this.#persist()
    return this.snapshot()
  }

  /** 供界面展示的快照。level / untilMs / remainingMs / reason / hint 一个都不能少。 */
  snapshot(atMs) {
    const now = this._at(atMs)
    const cfg = this.#cbConfig()
    const remaining = this.state.untilMs > now ? this.state.untilMs - now : 0
    const level = LEVEL_NAMES[this.state.level] || 'none'
    return {
      level,
      level_index: this.state.level,
      open: this.isOpen(now),
      untilMs: this.state.untilMs,
      remainingMs: remaining,
      reason: this.state.reason,
      hint: circuitHint(level, remaining),
      source: this.state.source,
      consecutiveFailures: this.state.consecutiveFailures,
      consecutiveFailureThreshold: cfg.platform_reject_threshold,
      platformRejectCount: this.state.platformRejectCount,
      platformRejectThreshold: cfg.platform_reject_threshold,
      failureRate: Number(this.#failureRate().toFixed(4)),
      failureRateWindow: this.#windowSize(),
      failureRateThreshold: cfg.failure_rate_threshold,
    }
  }

  /**
   * 与 guard.js 那份简化熔断的**合并视图**（纯查询，不改任何状态）。
   *
   * ⚠️ 规则：级别取大、到期取大、**任一 open 即为 open**。
   *    绝不做"取小"或"以某一方为准"的简化——那会让更保守的一方失效。
   *
   * @param {object} guard Guard 实例（可为 null）
   * @param {number} [atMs]
   */
  guardCircuit(guard, atMs) {
    const now = this._at(atMs)
    const mine = {
      level: this.state.level,
      untilMs: this.state.untilMs,
      reason: this.state.reason,
      open: this.isOpen(now),
    }
    if (!guard || !guard.circuit) {
      return { ...mine, levelName: LEVEL_NAMES[mine.level], from: mine.open ? 'circuit' : null }
    }
    const theirs = {
      level: CIRCUIT_LEVELS[guard.circuit.level] || 0,
      untilMs: Number(guard.circuit.untilMs || 0),
      reason: guard.circuit.reason || null,
      open: Boolean(guard.isCircuitOpen(now)),
    }
    const level = Math.max(mine.level, theirs.level)
    const untilMs = Math.max(mine.untilMs, theirs.untilMs)
    return {
      level,
      levelName: LEVEL_NAMES[level],
      untilMs,
      remainingMs: untilMs > now ? untilMs - now : 0,
      reason: mine.open ? mine.reason : theirs.reason,
      open: mine.open || theirs.open,
      from: mine.open && theirs.open ? 'both' : mine.open ? 'circuit' : theirs.open ? 'guard' : null,
      own: mine,
      guard: theirs,
    }
  }

  /**
   * 把合并结果**推进** guard，使 `guard.canSend()` 也能看到完整状态机的判定。
   *
   * ⚠️ **只允许收紧**：目标级别与到期时刻都取两者中的较大值。
   *    guard 说 L3、状态机说 L1 时不会被本方法降下来。
   *
   * ⚠️ 落盘说明：guard 的持久化是私有的，本方法只改内存中的 `guard.circuit`，
   *    因此返回值里的 `persisted` 为 false，调用方应在同一轮里调用
   *    `circuit.#persist` 的对等路径 —— 本模块自己的状态**已经**落盘，
   *    guard 的副本会在它下一次 `recordResult()` / `decayCircuit()` 时落盘。
   *
   * @param {object} guard Guard 实例
   * @returns {{applied:boolean, persisted:boolean, level:string, untilMs:number}}
   */
  applyToGuard(guard) {
    if (!guard || !guard.circuit || typeof guard.isCircuitOpen !== 'function') {
      throw new Error('applyToGuard 需要一个 Guard 实例')
    }
    const now = this._at()
    const merged = this.guardCircuit(guard, now)
    const before = {
      level: guard.circuit.level,
      untilMs: Number(guard.circuit.untilMs || 0),
      reason: guard.circuit.reason,
    }

    guard.circuit.level = merged.levelName
    guard.circuit.untilMs = merged.untilMs
    if (merged.open) guard.circuit.reason = merged.reason || 'circuit_state_machine'

    return {
      applied: before.level !== guard.circuit.level ||
        before.untilMs !== guard.circuit.untilMs ||
        before.reason !== guard.circuit.reason,
      persisted: false,
      level: guard.circuit.level,
      untilMs: guard.circuit.untilMs,
    }
  }

  // ── 内部 ──────────────────────────────────────────────────

  /**
   * 升级一级并开启冷却。
   *
   * ⚠️ 级别取"历史最高级别 + 1"而不是"当前级别 + 1"：
   *    冷却到期后 `decay()` 会把级别降回 0，若只按当前级别加，
   *    连续触发的梯度会退化成 l1→l1→l1。用 lastLevel 记住本次
   *    熔断过程中到过的最高级，连续触发才能稳定 l1→l2→l3。
   */
  #escalate(trigger, now, detail) {
    const cfg = this.#cbConfig()
    const from = this.state.level
    const next = Math.min(Math.max(from, this.state.lastLevel) + 1, CIRCUIT_LEVELS.l3)

    this.state.level = next
    this.state.lastLevel = next
    const cooldown = cooldownForLevel(next, cfg, now)
    this.state.untilMs = now + cooldown
    this.state.reason = trigger
    this.state.source = 'local'
    this.state.openedAtMs = now
    this.state.consecutiveFailures = 0
    if (trigger === 'platform_reject_count') this.state.platformRejectCount = 0
    this.#persist()

    return {
      ...this.snapshot(now),
      escalated: true,
      from_level: LEVEL_NAMES[from],
      cooldown_ms: cooldown,
      detail: detail || null,
    }
  }

  /** 追加一条窗口结果（1 = 成功、0 = 失败），长度受配置窗口与硬上限约束。 */
  #pushOutcome(ok) {
    const cfg = this.#cbConfig()
    const cap = Math.min(MAX_WINDOW_HARD_CAP, Math.max(cfg.failure_rate_window, 2))
    this.state.failureWindow.push(ok ? 1 : 0)
    if (this.state.failureWindow.length > cap) {
      this.state.failureWindow = this.state.failureWindow.slice(-cap)
    }
  }

  #windowSize() {
    return this.state.failureWindow.length
  }

  /** 窗口内失败率 ∈ [0,1]。空窗口返回 0（"没有证据"不等于"高失败率"）。 */
  #failureRate() {
    const w = this.state.failureWindow
    if (w.length === 0) return 0
    let fails = 0
    for (const v of w) if (!v) fails++
    return fails / w.length
  }

  /** 取时：显式 atMs 优先，否则用注入的 now()。非法时刻直接抛错（不猜）。 */
  _at(atMs) {
    const v = atMs === undefined ? this.now() : atMs
    const n = Number(v)
    if (!Number.isFinite(n)) throw new Error(`熔断状态机收到非法时刻：${v}`)
    return n
  }

  /**
   * 从 runtime-state.json 恢复。
   *
   * ⚠️ 必须恢复。否则**重启一次就绕过熔断**——风控刚触发，商家重开程序继续满速发。
   */
  #restore() {
    const st = this.store.readJson('runtime-state.json', defaultRuntimeState())
    const saved = st[STATE_KEY]
    if (!saved || typeof saved !== 'object') return

    const base = defaultState(this.now())
    this.state = {
      ...base,
      level: clampLevel(saved.level),
      lastLevel: clampLevel(saved.lastLevel),
      untilMs: Math.max(0, Number(saved.untilMs) || 0),
      reason: saved.reason || null,
      source: saved.source || null,
      openedAtMs: Math.max(0, Number(saved.openedAtMs) || 0),
      serverFloorMs: Math.max(0, Number(saved.serverFloorMs) || 0),
      consecutiveFailures: Math.max(0, Math.floor(Number(saved.consecutiveFailures) || 0)),
      platformRejectCount: Math.max(0, Math.floor(Number(saved.platformRejectCount) || 0)),
      lastFailureAtMs: Math.max(0, Number(saved.lastFailureAtMs) || 0),
      lastOutcomeAtMs: Math.max(0, Number(saved.lastOutcomeAtMs) || 0),
      lastReason: saved.lastReason || null,
      failureWindow: normalizeWindow(saved.failureWindow),
    }
    if (this.state.lastLevel < this.state.level) this.state.lastLevel = this.state.level
  }

  /**
   * 落盘。
   *
   * ⚠️ 必须走 `store.update` 的**读-改-写**，并且**只改自己那一个键**。
   *    runtime-state.json 是 guard 的主场（dayStartMs/usedBySource/
   *    lastSentAtMs/emergencyStop/overrides），全量覆写会把日用量清零——
   *    那就是"重启即可重置日上限"的护栏失效缺陷（红线 1）。
   *
   * ⚠️ 写不进盘时抛错而不是吞掉：状态丢失等于熔断失效（AGENTS.md §2.8）。
   */
  #persist() {
    try {
      this.store.update('runtime-state.json', defaultRuntimeState(), (state) => {
        state[STATE_KEY] = { ...this.state, failureWindow: this.state.failureWindow.slice() }
        state.updatedAtMs = this._at()
        return state
      })
    } catch (e) {
      throw new Error(`保存熔断状态失败（重启后熔断可能丢失，请检查磁盘）：${e.message}`)
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 纯函数工具
// ═══════════════════════════════════════════════════════════

/** 默认状态。每次 clear()/构造都生成**新对象**，避免共享引用。 */
function defaultState(atMs) {
  return {
    level: 0,                 // 0=none 1=l1 2=l2 3=l3
    lastLevel: 0,             // 本次熔断过程中到过的最高级别（升级用它 +1）
    untilMs: 0,               // 本次冷却的到期时刻（已含服务端下限）
    reason: null,
    source: null,             // local | server
    openedAtMs: 0,
    serverFloorMs: 0,         // 服务端给过的最大冷却截止时刻（权威下限，decay 不得突破）
    consecutiveFailures: 0,
    platformRejectCount: 0,
    lastFailureAtMs: 0,
    lastOutcomeAtMs: atMs || 0,
    lastReason: null,
    failureWindow: [],        // 最近 N 条结果（1=成功 0=失败），长度有界
  }
}

/** 某级别的冷却时长。L3 = 停到次日 00:00(UTC+8)。 */
function cooldownForLevel(level, cfg, atMs) {
  if (level >= CIRCUIT_LEVELS.l3) return msUntilNextDay(atMs)
  if (level === CIRCUIT_LEVELS.l2) return cfg.l2_cooldown_ms
  return cfg.l1_cooldown_ms
}

/**
 * 距下一个自然日 0 点（UTC+8）还有多久。
 * ⚠️ 与服务端 billing.js / guard.js 使用同一个 dayStartMs —— "哪一天"的定义
 *    全项目只能有一份（shared/lib/protocol.js 的 MS_PER_DAY / TZ_OFFSET_MINUTES）。
 */
function msUntilNextDay(atMs) {
  return dayStartMs(atMs) + MS_PER_DAY - atMs
}

/** 面向商家的中文提示。UI 必须能回答"第几级、什么时候恢复"。 */
function circuitHint(level, remainingMs) {
  const mins = Math.max(0, Math.ceil(remainingMs / 60000))
  switch (level) {
    case 'l3': return `已停止发送至次日 00:00（约 ${mins} 分钟后恢复，请先处理账号风控提示）`
    case 'l2': return `已暂停 1 小时（剩余约 ${mins} 分钟）`
    case 'l1': return `已暂停 30 分钟（剩余约 ${mins} 分钟）`
    default: return '运行正常'
  }
}

/** 还原级别（损坏值一律当 0，宁可少一级记忆也不要越界）。 */
function clampLevel(v) {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > CIRCUIT_LEVELS.l3) return 0
  return n
}

/** 还原失败窗口：只接受 0/1 形态，长度硬上限兜底。 */
function normalizeWindow(w) {
  if (!Array.isArray(w)) return []
  const out = []
  for (const v of w.slice(-MAX_WINDOW_HARD_CAP)) out.push(v ? 1 : 0)
  return out
}

module.exports = {
  CircuitBreaker,
  // 常量与工具（供测试与调用方复用，避免各处重复定义）
  L1_COOLDOWN_MS,
  L2_COOLDOWN_MS,
  TRIGGER_REASONS,
  CAPTCHA_REASONS,
  STATE_KEY,
  LEVEL_NAMES,
  MAX_WINDOW_HARD_CAP,
  FALLBACK,
  msUntilNextDay,
  cooldownForLevel,
  circuitHint,
  defaultState,
  // 转出 guard.js 的工具，便于调用方只 require 本模块
  CIRCUIT_LEVELS,
  dayStartMs,
}
