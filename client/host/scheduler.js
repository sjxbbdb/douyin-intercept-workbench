'use strict'

// client/host/scheduler.js
//
// 调度器 —— 客户端的**唯一**循环驱动者。
//
// ⚠️ 本模块有三条不可妥协的职责，任何一条做错都会让整个产品失去意义：
//
//   ① **它不判断"能不能发"**。是否允许发送**只有一个**判定点：
//      `client/safety/guard.js` 的 `canSend()`。调度器只负责"问它"，
//      并根据答案决定继续还是等待。把限额判断写进调度循环是本项目
//      最难查的一类缺陷——因为护栏改动不会影响它，两处逻辑必然漂移，
//      而漂移的方向通常是"绕过护栏"（红线 1）。
//
//   ② **所有定时器都必须可停**。调度器持有 4 个循环（心跳 60s、
//      明细上报 5min、聚合上报 30min、任务循环）+ 熔断冷却定时器。
//      停止/重启时必须全部清掉。漏掉一个的表现是"停不干净"——
//      进程看似退出但仍在后台发送，或重启后同一条评论被回复两次。
//      所以所有句柄集中登记在 `#timers`，由 `stop()` 统一清理。
//
//   ③ **幂等拒绝重复启动**（计划文档 D-13）。两个调度器同时跑 =
//      两个循环同时抢任务、同时发心跳、同时上报。这里用 in-process
//      标记 + 磁盘上的 pid/启动时间双重防护：前者挡同进程误用，
//      后者挡"上一次没退干净"。
//
// ⚠️ 循环之间**刻意解耦**：心跳失败不影响本地任务循环，上报失败不影响
//    心跳。旧代码把三者串在一个 try 里，任何一步抛错都会让整个循环死掉，
//    而表现只是"程序还在跑，但什么都不做"。

const { SOURCE_TYPES, PATHS } = require('../../shared/lib/protocol')

/** 循环周期（可由服务端 limits 覆盖） */
const DEFAULTS = Object.freeze({
  heartbeatMs: 60000,
  reportSendsMs: 300000,
  reportUsageMs: 1800000,
  /** 任务循环之间的最小间隔（真正的间隔由 timing.js 的对数正态分布决定） */
  taskLoopMinGapMs: 2000,
  /** 一次循环最多处理多少条任务，避免长时间不让出事件循环 */
  taskLoopMaxPerCycle: 3,
})

/** 需要"重新入队"而不是"判失败"的错误码白名单（自愈率 ≥95% 的关键） */
const RETRYABLE_CODES = Object.freeze([
  'TAB_LOST', 'CDP_DISCONNECTED', 'CDP_TIMEOUT', 'ELEMENT_TIMEOUT',
  'ELEMENT_ZERO_SIZE', 'PANEL_NOT_EXPANDED', 'NET_TIMEOUT',
  'SERVER_UNAVAILABLE', 'SERVER_DB_BUSY', 'RATE_TOO_MANY_REQUESTS',
])

class Scheduler {
  /**
   * @param {object} opts
   * @param {object} opts.store
   * @param {object} opts.guard        安全护栏（唯一准入判定）
   * @param {object} opts.queue
   * @param {object} opts.auth
   * @param {object} opts.heartbeat
   * @param {object} opts.reporter
   * @param {object} [opts.http]       传输层（`reload_policy` 时按需拉策略）
   * @param {object} opts.executor     任务执行器：async (task) => result
   * @param {object} [opts.logger]
   * @param {() => number} [opts.now]
   * @param {(phase: string, detail: object) => void} [opts.onStateChange]
   */
  constructor(opts) {
    if (!opts || !opts.store || !opts.guard || !opts.queue || !opts.auth
        || !opts.heartbeat || !opts.reporter) {
      throw new Error('Scheduler 需要 store / guard / queue / auth / heartbeat / reporter')
    }
    this.store = opts.store
    this.guard = opts.guard
    this.queue = opts.queue
    this.auth = opts.auth
    this.heartbeat = opts.heartbeat
    this.reporter = opts.reporter
    this.http = opts.http || null
    this.executor = opts.executor || null
    this.logger = opts.logger || null
    this.now = opts.now || (() => Date.now())
    this.onStateChange = opts.onStateChange || null

    /** 引擎状态：running / paused / stopped / error */
    this.state = 'stopped'
    this.stateReason = null
    /** 所有定时器句柄（⚠️ 必须全部登记，stop() 才能清干净） */
    this.#timers = new Map()
    /** 防止 taskLoop 重入 */
    this.#taskLoopRunning = false
    /** 运行统计（界面用） */
    this.stats = {
      startedAtMs: 0,
      taskCycles: 0,
      tasksDone: 0,
      tasksSkipped: 0,
      tasksFailed: 0,
      tasksRequeued: 0,
      heartbeats: 0,
      heartbeatFailures: 0,
      sendsReports: 0,
      usageReports: 0,
      lastHeartbeatMs: 0,
      lastError: null,
      blockedBy: null,
    }

    /** 由服务器命令设置的停机截止时间（熔断/停机指令） */
    this.pausedUntilMs = 0
    this.pauseReason = null

    /** 聚合统计窗口累积器（按渠道） */
    this.window = newWindow(this.now())
  }

  /** @type {Map<string, any>} */
  #timers
  #taskLoopRunning

  // ══════════════════════════════════════════════════════════
  // 生命周期
  // ══════════════════════════════════════════════════════════

  /**
   * 启动。
   *
   * ⚠️ 幂等：已在运行时直接返回，不重复起定时器。
   *    重复启动的后果是每条评论被回复两次、心跳频率翻倍——
   *    而它只在"误调用两次"时出现，测试很容易漏掉。
   */
  start() {
    if (this.state === 'running') {
      this.#log('warn', 'scheduler_already_running', {})
      return { started: false, reason: 'already_running' }
    }

    const lock = this.#acquireRunLock()
    if (!lock.ok) {
      this.#log('error', 'scheduler_lock_denied', lock)
      return { started: false, reason: lock.reason, detail: lock.detail }
    }

    // ⚠️ 崩溃恢复：先放回遗留的 processing 任务，再开始取任务。
    //    顺序反了会让"刚放回的任务"与"新取的任务"混在一起。
    const rec = this.queue.recoverInFlight()
    if (rec.recovered > 0) this.#log('info', 'queue_recovered_in_flight', rec)

    this.state = 'running'
    this.stateReason = null
    this.stats.startedAtMs = this.now()

    this.#schedule('heartbeat', DEFAULTS.heartbeatMs, () => this.#heartbeatCycle())
    this.#schedule('reportSends', DEFAULTS.reportSendsMs, () => this.#reportSendsCycle())
    this.#schedule('reportUsage', DEFAULTS.reportUsageMs, () => this.#reportUsageCycle())
    this.#schedule('taskLoop', DEFAULTS.taskLoopMinGapMs, () => this.#taskCycle())

    // ⚠️ 首次心跳延后一个短间隔而不是立即发：登录响应刚刚建立了状态，
    //    立刻再发一次心跳只会浪费一次 nonce 与 seq。
    this.#schedule('firstHeartbeat', 1500, () => this.#heartbeatCycle())

    this.#emit('started', { at_ms: this.now() })
    this.#log('info', 'scheduler_started', {})
    return { started: true }
  }

  /**
   * 停止。
   *
   * ⚠️ 必须清掉**全部**定时器。哪怕漏一个，也会出现
   *    "界面显示已停止，但还在后台发送"——这是最危险的形态，
   *    因为商家以为自己按了停。
   */
  stop(reason) {
    const wasRunning = this.state === 'running'
    for (const [name, handle] of this.#timers) {
      clearTimeout(handle)
      clearInterval(handle)
      this.#timers.delete(name)
    }
    this.state = 'stopped'
    this.stateReason = reason || null
    this.#releaseRunLock()
    if (wasRunning) {
      this.#emit('stopped', { reason: this.stateReason, at_ms: this.now() })
      this.#log('info', 'scheduler_stopped', { reason: this.stateReason })
    }
    return { stopped: true, wasRunning }
  }

  /** 暂缓到某时刻（熔断冷却、余额耗尽停机）。 */
  pauseUntil(untilMs, reason) {
    this.pausedUntilMs = Number(untilMs || 0)
    this.pauseReason = reason || null
    if (this.state === 'running') {
      this.state = 'paused'
      this.stateReason = this.pauseReason
      this.#emit('paused', { until_ms: this.pausedUntilMs, reason: this.pauseReason })
    }
    return { paused_until_ms: this.pausedUntilMs, reason: this.pauseReason }
  }

  /** 恢复（余额充值后、熔断冷却到期）。 */
  resume(reason) {
    this.pausedUntilMs = 0
    this.pauseReason = null
    if (this.state === 'paused') {
      this.state = 'running'
      this.stateReason = null
      this.#emit('resumed', { reason: reason || null })
    }
    return { resumed: true }
  }

  /** 当前是否允许开展发送类工作。 */
  isSendWindowOpen() {
    if (this.state !== 'running') return { open: false, reason: this.state }
    if (this.pausedUntilMs > this.now()) {
      return { open: false, reason: 'paused_until', until_ms: this.pausedUntilMs, detail: this.pauseReason }
    }
    return { open: true }
  }

  /**
   * 手动跑一轮任务循环。
   *
   * ⚠️ 存在的理由有两个，都很实际：
   *   1. **启动时立刻处理一批**：登录完成、策略到位后不该干等一个周期。
   *   2. **让行为可确定性测试**。定时器驱动的代码在测试里只能"等"，
   *      而等出来的测试既慢又不稳定。暴露一次性入口，
   *      测试就能精确断言"护栏拒绝时执行器一次都没被调用"。
   *
   * 内部有重入保护，与定时器触发的那条路径共用同一份实现。
   */
  async runTaskCycleOnce() {
    return this.#taskCycle()
  }

  /** 手动跑一次心跳循环（含时钟偏差自愈、命令执行、策略 reload）。 */
  async runHeartbeatOnce() {
    return this.#heartbeatCycle()
  }

  /** 手动跑一次明细上报循环。 */
  async runSendsReportOnce() {
    return this.#reportSendsCycle()
  }

  /** 手动跑一次聚合上报循环。 */
  async runUsageReportOnce() {
    return this.#reportUsageCycle()
  }

  /** 手动结算一个聚合窗口并返回窗口数据（测试与排障用）。 */
  closeWindowNow() {
    return this.#closeWindow()
  }

  /** 界面快照。 */
  snapshot() {
    const q = this.queue.stats()
    const g = this.guard.snapshot()
    return {
      state: this.state,
      state_reason: this.stateReason,
      paused_until_ms: this.pausedUntilMs,
      pause_reason: this.pauseReason,
      timers: [...this.#timers.keys()],
      queue: q,
      guard: g,
      stats: { ...this.stats },
      engine_state: this.#engineState(),
    }
  }

  #engineState() {
    if (this.state === 'stopped') return 'stopped'
    if (this.state === 'paused') return 'paused'
    if (this.stats.taskCycles === 0) return 'idle'
    return 'running'
  }

  // ══════════════════════════════════════════════════════════
  // 心跳循环
  // ══════════════════════════════════════════════════════════

  async #heartbeatCycle() {
    // ⚠️ 心跳**在暂停时也要发**。理由：服务端需要知道客户端还在线，
  //    而且恢复发送的指令（resume_engine）只能通过心跳送达。
  //    不发心跳 = 客户端与服务端失联，充值后也不会自动恢复。
    if (this.state === 'stopped') return
    try {
      const r = await this.heartbeat.send()
      this.stats.heartbeats += 1
      this.stats.lastHeartbeatMs = this.now()
      this.stats.blockedBy = null
      // ⚠️ 续租运行锁。否则 2 分钟后锁被视为过期，另一个实例就能启动，
      //    于是两个调度器同时跑——那正是运行锁要防的情况。
      this.renewRunLock()

      // ── 服务端命令：必须在 60 秒内执行（契约 §4.5）──────────
      const stop = r.stop
      if (stop) {
        if (stop.action === 'stop') {
          // 停机类指令（版本过低、账号停用）：直接停调度，不自动恢复。
          this.stop(`server_command:${stop.reason}`)
          return
        }
        this.pauseUntil(stop.cooldown_until_ms || (this.now() + 60000), stop.reason)
      } else if (this.state === 'paused' && r.commands.some((c) => c && c.type === 'resume_engine')) {
        // 服务端说可以恢复 → 仍需通过护栏检查（观察期/熔断/急停）
        const gate = this.guard.canSend({ sourceType: 'comment' })
        if (gate.allow) this.resume('server_command:resume_engine')
        else this.#log('info', 'resume_denied_by_guard', { reason: gate.reason })
      }

      // ── 余额耗尽 → fail-closed 停机，不退避重试 ────────────
      if (r.body && r.body.state === 'exhausted') {
        this.pauseUntil(Number.MAX_SAFE_INTEGER, 'CREDIT_EXHAUSTED')
        this.#emit('credit_exhausted', { balance_milli: r.body.credit ? r.body.credit.balance_milli : null })
      }

      // ── 服务端熔断 → 与本地递进级别取较长者 ────────────────
      const cb = r.body && r.body.circuit_breaker
      if (cb && cb.open && cb.cooldown_until_ms) {
        const local = this.guard.circuit.untilMs || 0
        const until = Math.max(Number(cb.cooldown_until_ms), local)
        this.pauseUntil(until, `circuit_breaker:${cb.trigger || 'server'}`)
      }

      // ── 时钟偏差告警（仅提示，不阻断）─────────────────────
      const skewWarn = this.heartbeat.clockSkewWarning()
      if (skewWarn) this.#emit('clock_skew_warning', skewWarn)

      // ⚠️ 服务端可能要求重新拉策略（reload_policy 命令）。心跳层只置标记，
      //    真正的拉取放在这里——避免心跳内部嵌套请求导致超时叠加。
      if (this.heartbeat.needsPolicyReload) {
        this.heartbeat.needsPolicyReload = false
        await this.#reloadPolicy()
      }
    } catch (e) {
      this.stats.heartbeatFailures += 1
      this.stats.lastError = { code: e && e.code, message: e && e.message, at_ms: this.now() }

      // ⚠️ 身份类错误：继续心跳毫无意义，停到用户重新登录。
      if (this.auth.constructor.isReauthRequired(e.code)) {
        this.auth.markCredentialInvalid(e.code, e.detail)
        this.stop(`credential_invalid:${e.code}`)
        return
      }
      // ⚠️ 需要停机类错误：立即停，不重试（验签失败 = 链路不可信）
      if (this.auth.constructor.isStopRequired(e.code)) {
        this.stop(`stop_required:${e.code}`)
        return
      }

      // 余额耗尽（402）：维持暂停，5 分钟退避重试心跳（契约 §9.4）
      if (e.code === 'CREDIT_EXHAUSTED') {
        this.pauseUntil(this.now() + 300000, 'CREDIT_EXHAUSTED')
        this.#emit('credit_exhausted', { detail: e.detail })
      }

      const delay = this.heartbeat.recordFailure(e)
      this.#reschedule('heartbeat', delay)
    }
  }

  /** 主动拉取策略（reload_policy / POLICY_VERSION_UNKNOWN 时用）。 */
  async #reloadPolicy() {
    if (!this.http) {
      this.#log('warn', 'policy_reload_skipped', { reason: 'scheduler_has_no_http' })
      return
    }
    try {
      const res = await this.http.request({ method: 'GET', path: PATHS.policyCurrent })
      const policy = res.body && res.body.policy
      if (policy) {
        this.auth.state.adoptPolicy(policy)
        this.guard.applyPolicy(policy)
        this.#log('info', 'policy_reloaded', { policy_version: policy.policy_version })
      }
    } catch (e) {
      // ⚠️ 不吞错。拉不到策略意味着限额可能已过期，必须留痕。
      this.#log('warn', 'policy_reload_failed', { code: e && e.code, message: e && e.message })
      this.stats.lastError = { code: e && e.code, message: e && e.message, at_ms: this.now() }
    }
  }

  // ══════════════════════════════════════════════════════════
  // 上报循环
  // ══════════════════════════════════════════════════════════

  async #reportSendsCycle() {
    if (this.state === 'stopped') return
    try {
      // ⚠️ 无明细时 reportSends 返回 null 且**不发请求**（契约 §9.1：
      //    "无发送则空批不上报"）。不要在这里补一个 force:true。
      const r = await this.reporter.reportSends()
      if (r) {
        this.stats.sendsReports += 1
        if (r.exhausted) {
          this.pauseUntil(Number.MAX_SAFE_INTEGER, 'CREDIT_EXHAUSTED')
          this.#emit('credit_exhausted', { balance_milli: r.settlement && r.settlement.balance_milli })
        }
        if (r.failClosed) {
          // ⚠️ 契约 §5.4：验签失败必须立即停机，不能只记日志继续跑。
          this.stop(`report_fail_closed:${r.error}`)
          return
        }
        this.#applyReportCommands(r.commands)
      }
    } catch (e) {
      this.#onReportError('sends', e)
    }
  }

  async #reportUsageCycle() {
    if (this.state === 'stopped') return
    const win = this.#closeWindow()
    // 窗口内一条计数都没有就不发（省请求，也避免看板出现空窗口）
    if (win.total === 0) return
    try {
      await this.reporter.reportUsage(win.window)
      this.stats.usageReports += 1
      this.#log('info', 'usage_reported', { window: win.window.window_start_ms })
    } catch (e) {
      this.#onReportError('usage', e)
      // ⚠️ 上报失败要把窗口数据**并回**下一个窗口，不能丢。
      //    丢了就永久少一段统计，看板数字与明细对不上。
      this.#mergeBackWindow(win)
    }
  }

  #onReportError(kind, e) {
    this.stats.lastError = { code: e && e.code, message: e && e.message, at_ms: this.now(), kind }
    if (this.auth.constructor.isStopRequired(e.code)) {
      this.stop(`stop_required:${e.code}`)
      return
    }
    if (this.auth.constructor.isReauthRequired(e.code)) {
      this.auth.markCredentialInvalid(e.code, e.detail)
      this.stop(`credential_invalid:${e.code}`)
      return
    }
    this.#log('warn', `report_${kind}_failed`, { code: e && e.code })
  }

  /** 执行上报响应里的命令（与心跳命令同语义）。 */
  #applyReportCommands(commands) {
    for (const c of commands || []) {
      if (!c || typeof c !== 'object') continue
      if (c.type === 'pause_engine') {
        this.pauseUntil(c.cooldown_until_ms || (this.now() + 60000), c.reason || 'pause_engine')
      } else if (c.type === 'circuit_break') {
        const until = Math.max(Number(c.cooldown_until_ms || 0), this.guard.circuit.untilMs || 0)
        this.pauseUntil(until, 'POLICY_CIRCUIT_OPEN')
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // 任务循环
  // ══════════════════════════════════════════════════════════

  /**
   * 处理任务的循环。
   *
   * ⚠️ 两处最容易写错：
   *
   *   ① **准入判定必须问护栏，不能自己看限额**。这里只调 `canSend()`，
   *      不在本文件出现任何 daily_max / min_interval 的比较。
   *
   *   ② **取任务之前先判定**。反了（先取后判）会让任务在"不允许发送"时
   *      被反复取出又放回，attempts 白涨，最终把好任务耗成 failed。
   */
  async #taskCycle() {
    if (this.state === 'stopped') return
    if (this.#taskLoopRunning) return
    this.#taskLoopRunning = true
    try {
      this.stats.taskCycles += 1

      // ⚠️ 本轮已尝试过的任务不再重试。
      //    动机很实际：requeue 会把任务立刻放回 queued，而队头又是它，
      //    于是同一个循环里它会被反复取出。后果有两个：
      //      · `attempts` 在毫秒内涨到上限，一条本该重试的评论直接被判死；
      //      · 循环被同一条任务占满，后面的正常任务这一轮完全处理不到。
      //    判据用任务 id（不是 dedupKey）——同一次任务实例才算重复。
      const attemptedThisCycle = new Set()

      for (let n = 0; n < DEFAULTS.taskLoopMaxPerCycle; n++) {
        // ── ① 熔断冷却到期 → 显式降级（而不是查询时隐式改状态）────
        if (this.guard.circuit.level !== 'none' && !this.guard.isCircuitOpen(this.now())) {
          this.guard.decayCircuit(this.now())
        }
        // ── ② 暂停到期 → 尝试恢复（仍需护栏点头）────────────
        if (this.state === 'paused' && this.now() >= this.pausedUntilMs) {
          const gate = this.guard.canSend({ sourceType: 'comment' })
          if (gate.allow) this.resume('pause_expired')
        }
        const win = this.isSendWindowOpen()
        if (!win.open) {
          this.stats.blockedBy = win.reason
          break
        }

        const task = this.queue.take()
        if (!task) break

        if (attemptedThisCycle.has(task.id)) {
          // 本轮已经碰过它 → 放回并结束本轮，把机会留给别的任务。
          this.queue.requeue(task.id, 'deferred_to_next_cycle')
          this.stats.blockedBy = 'same_task_repeated'
          break
        }
        attemptedThisCycle.add(task.id)

        const sourceType = task.sourceType || 'comment'
        const gate = this.guard.canSend({ sourceType, atMs: this.now() })
        if (!gate.allow) {
          // ⚠️ 放回而不是失败。护栏拒绝是**正常状态**（观察期、日上限到、
          //    不在活跃时段），不是任务的问题。
          this.queue.requeue(task.id, `guard:${gate.reason}`)
          this.stats.blockedBy = gate.reason
          // 观察期 / 日上限到 / 非活跃时段 → 本轮不再尝试，等下一轮
          break
        }

        // ⚠️ 到这里才认为"护栏允许了一条"。执行器负责全部平台动作，
        //    并把成功判定来自平台响应体这件事做对。
        if (!this.executor) {
          this.queue.requeue(task.id, 'no_executor')
          break
        }

        let result
        try {
          result = await this.executor(task)
        } catch (e) {
          this.#handleTaskError(task, e)
          continue
        }
        this.#handleTaskResult(task, result)
      }
    } finally {
      this.#taskLoopRunning = false
    }
  }

  #handleTaskError(task, e) {
    this.stats.lastError = { code: e && e.code, message: e && e.message, at_ms: this.now(), task_id: task.id }
    if (RETRYABLE_CODES.includes(e && e.code)) {
      // ⚠️ 可重试故障 → 放回队列。这是自愈率 ≥95% 的关键。
      this.queue.requeue(task.id, e.code)
      this.stats.tasksRequeued += 1
      this.#log('info', 'task_requeued', { task_id: task.id, code: e.code })
      return
    }
    this.queue.fail(task.id, e && e.code ? e.code : 'unknown', { message: e && e.message })
    this.stats.tasksFailed += 1
    this.#log('warn', 'task_failed', { task_id: task.id, code: e && e.code })

    // ⚠️ 记录平台结果供熔断判定。护栏负责状态机，这里只转交。
    this.guard.recordResult({ ok: false, reason: mapFailureForCircuit(e) })
    this.#checkCircuitAfterFailure()
  }

  #handleTaskResult(task, result) {
    if (!result || typeof result !== 'object') {
      this.queue.fail(task.id, 'executor_returned_nothing')
      this.stats.tasksFailed += 1
      return
    }

    // ── 跳过（命中但不回复：已在窗口内回复过该用户等）─────────
    if (result.outcome === 'skipped') {
      this.queue.skip(task.id, result.reason || 'skipped')
      this.stats.tasksSkipped += 1
      this.#countWindow(task.sourceType, 'skipped')
      // ⚠️ 跳过**不算失败**，不进熔断计数——否则"用户被回复过"这种
      //    正常情况会累积成熔断，账号被无谓地停掉。
      return
    }

    // ── 成功 ────────────────────────────────────────────────
    if (result.outcome === 'done') {
      this.queue.done(task.id, result.detail || null)
      this.stats.tasksDone += 1
      if (result.userKeyHash) {
        this.queue.markReplied({
          dedupKey: task.dedupKey,
          userKeyHash: result.userKeyHash,
          sourceType: task.sourceType,
          atMs: this.now(),
        })
      }
      if (result.verdict) this.#countWindow(task.sourceType, result.verdict)
      // ⚠️ 只有平台确认成功才记入护栏的日用量。DOM 判据（sent_confirmed_dom）
      //    与疑似（sent_suspected）也必须占本地日额度——因为**平台那边
      //    它们已经发生了**，不占额度会让第二天超发。
      this.guard.recordSent({ sourceType: task.sourceType, atMs: this.now() })
      this.guard.recordResult({ ok: true })
      return
    }

    // ── 失败（平台明确拒绝）────────────────────────────────
    this.queue.fail(task.id, result.failureReason || 'unknown', result.evidence || null)
    this.stats.tasksFailed += 1
    if (result.verdict) this.#countWindow(task.sourceType, result.verdict)
    this.guard.recordResult({ ok: false, reason: result.failureReason })
    this.#checkCircuitAfterFailure()
  }

  /** 熔断判定交给护栏；这里只把护栏的结论同步进调度器的暂停状态。 */
  #checkCircuitAfterFailure() {
    if (this.guard.isCircuitOpen(this.now())) {
      const until = this.guard.circuit.untilMs
      this.pauseUntil(Math.max(until, this.pausedUntilMs), `circuit:${this.guard.circuit.level}`)
      this.#emit('circuit_open', {
        level: this.guard.circuit.level,
        until_ms: until,
        reason: this.guard.circuit.reason,
      })
    }
  }

  // ══════════════════════════════════════════════════════════
  // 聚合窗口（内存累积，30 分钟一封）
  // ══════════════════════════════════════════════════════════

  /** 记录一次发送尝试的判定（执行器返回后由调度器调用）。 */
  countWindow(sourceType, verdict) {
    return this.#countWindow(sourceType, verdict)
  }

  #countWindow(sourceType, verdict) {
    if (!sourceType || !SOURCE_TYPES.includes(sourceType)) return
    const s = this.window.window.sources[sourceType]
    if (!s) return
    // ⚠️ `skipped` 与四个 `verdict` 属于**不同字段**（契约 §7.1 vs §7.2）：
    //    · `skipped`   = "命中但**未发起**回复"，没有 send_id，不占 reply_attempts
    //    · `verdict`   = "一次**发送尝试**的判定"，闭集四个值
    //    契约的约束是：sent_confirmed + sent_confirmed_dom + sent_suspected
    //    + failed === reply_attempts。所以 reply_attempts 只能在这四个
    //    verdict 上递增，**且每个 verdict 恰好一次**。
    if (verdict === 'skipped') {
      s.skipped += 1
      return
    }
    if (!Object.prototype.hasOwnProperty.call(s, verdict)) {
      // 未知 verdict：不能静默计数（会让对账永远对不上），但也不该抛错
      // 打断发送。记一个显式的桶，让对账能看出"有东西没被识别"。
      s.unknown_verdict = (s.unknown_verdict || 0) + 1
      return
    }
    s[verdict] += 1
    s.reply_attempts += 1
  }

  /** 记录一次命中（采集到符合关键词的评论）。 */
  recordHit(sourceType, { isNewLead, uniqueUser } = {}) {
    const s = this.window.window.sources[sourceType]
    if (!s) return
    s.hits += 1
    if (isNewLead) s.leads_new += 1
    if (uniqueUser) s.unique_users += 1
    this.window.total += 1
  }

  /** 记录一次失败归因。 */
  recordFailureReason(reason) {
    if (!reason) return
    const fr = this.window.window.failure_reasons
    fr[reason] = (fr[reason] || 0) + 1
    this.window.total += 1
  }

  #closeWindow() {
    const win = this.window
    const end = this.now()
    this.window = newWindow(end)
    win.window.window_end_ms = end
    return win
  }

  /** 上报失败时把窗口并回（不丢统计）。 */
  #mergeBackWindow(win) {
    const cur = this.window.window
    cur.window_start_ms = Math.min(cur.window_start_ms, win.window.window_start_ms)
    for (const src of SOURCE_TYPES) {
      for (const k of Object.keys(cur.sources[src])) {
        cur.sources[src][k] += win.window.sources[src][k] || 0
      }
    }
    for (const [k, v] of Object.entries(win.window.failure_reasons || {})) {
      cur.failure_reasons[k] = (cur.failure_reasons[k] || 0) + v
    }
    cur.unique_users_total += win.window.unique_users_total || 0
    this.window.total += win.total
  }

  // ══════════════════════════════════════════════════════════
  // 定时器与运行锁
  // ══════════════════════════════════════════════════════════

  #schedule(name, ms, fn) {
    const handle = setInterval(() => {
      // ⚠️ 每个循环独立捕获异常。一个循环抛错不能带走定时器，
      //    否则表现是"程序还在跑，但那个功能永久静默"。
      Promise.resolve()
        .then(fn)
        .catch((e) => this.#log('error', `${name}_cycle_threw`, { message: e && e.message, code: e && e.code }))
    }, ms)
    this.#timers.set(name, handle)
    return handle
  }

  #reschedule(name, ms) {
    clearInterval(this.#timers.get(name))
    const handle = setTimeout(() => {
      this.#timers.delete(name)
      // 退避后重新回到常规周期
      Promise.resolve()
        .then(() => this.#heartbeatCycle())
        .catch((e) => this.#log('error', 'heartbeat_cycle_threw', { message: e && e.message }))
      this.#schedule('heartbeat', DEFAULTS.heartbeatMs, () => this.#heartbeatCycle())
    }, ms)
    this.#timers.set(name, handle)
  }

  /**
   * 获取运行锁。
   *
   * ⚠️ 两层防护：
   *   · 进程内：`Scheduler` 实例自己的 state（挡误调用两次 start）
   *   · 磁盘：`runtime-state.json` 里的 `schedulerPid` + `schedulerStartedAtMs`
   *     （挡"上一次没退干净"——这种情况在 Windows 上很常见，
   *      用户直接关窗口，进程可能还在）
   *
   * ⚠️ 但**不能**因为"上次的 pid 还在"就拒绝启动：pid 会被复用，
   *    而拒绝启动会让用户彻底打不开程序。所以判据是"pid 存在**且**
   *    心跳在 2 分钟内更新过"——那才说明真的还有另一个实例在跑。
   */
  #acquireRunLock() {
    const pid = process.pid
    const now = this.now()
    const st = this.store.readJson('runtime-state.json', {})
    const otherPid = Number(st.schedulerPid || 0)
    const lastBeat = Number(st.schedulerHeartbeatMs || 0)
    const fresh = lastBeat > 0 && now - lastBeat < 120000

    if (otherPid && otherPid !== pid && fresh) {
      return {
        ok: false,
        reason: 'another_instance_running',
        detail: { other_pid: otherPid, last_heartbeat_ms: lastBeat },
      }
    }

    this.store.update('runtime-state.json', {}, (s) => {
      s.schedulerPid = pid
      s.schedulerStartedAtMs = now
      s.schedulerHeartbeatMs = now
      return s
    })
    return { ok: true }
  }

  #releaseRunLock() {
    try {
      this.store.update('runtime-state.json', {}, (s) => {
        if (Number(s.schedulerPid || 0) === process.pid) {
          s.schedulerPid = 0
          s.schedulerStoppedAtMs = this.now()
        }
        return s
      })
    } catch (e) {
      // ⚠️ 释放锁失败必须留痕但不阻断停止流程——
      //    否则用户在界面上按"停止"会看到一个报错，而实际已经停了。
      this.#log('warn', 'release_run_lock_failed', { message: e && e.message })
    }
  }

  /** 心跳续租运行锁（由心跳循环调用，让别的实例能判断我们是否还活着）。 */
  renewRunLock() {
    this.store.update('runtime-state.json', {}, (s) => {
      s.schedulerHeartbeatMs = this.now()
      return s
    })
  }

  #emit(phase, detail) {
    try {
      if (this.onStateChange) this.onStateChange(phase, detail)
    } catch (e) {
      // ⚠️ 回调错误不得影响调度。但也不能静默——记下来。
      this.#log('warn', 'state_change_callback_threw', { phase, message: e && e.message })
    }
  }

  #log(level, msg, detail) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](msg, detail)
  }
}

// ══════════════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════════════

function newWindow(nowMs) {
  const sources = {}
  for (const src of SOURCE_TYPES) {
    sources[src] = {
      hits: 0, leads_new: 0, reply_attempts: 0,
      sent_confirmed: 0, sent_confirmed_dom: 0, sent_suspected: 0,
      failed: 0, skipped: 0, unique_users: 0,
    }
  }
  return {
    window: {
      window_start_ms: nowMs,
      window_end_ms: nowMs,
      sources,
      failure_reasons: {},
      unique_users_total: 0,
    },
    total: 0,
  }
}

/**
 * 把执行器抛出的错误映射成熔断可用的归因。
 *
 * ⚠️ 只有**平台侧**的失败才应该触发熔断。把 `element_timeout`
 *    （页面没加载出来）当成风控信号会让账号被无谓地停掉——
 *    而熔断是递进的（30 分钟 → 1 小时 → 停到次日），代价很高。
 */
function mapFailureForCircuit(e) {
  const code = (e && e.code) || ''
  if (code === 'RISK_CONTROL_REJECTED' || code === 'EMPTY_RESPONSE') return 'risk_control_rejected'
  if (code === 'ACCOUNT_RISK' || code === 'CAPTCHA_APPEARED') return 'account_risk'
  if (code === 'CONTENT_REJECTED') return 'content_rejected'
  if (code === 'RATE_LIMITED') return 'rate_limited'
  // 页面类故障不参与熔断（不是账号问题的信号）
  return 'element_timeout'
}

module.exports = {
  Scheduler,
  DEFAULTS,
  RETRYABLE_CODES,
  newWindow,
  mapFailureForCircuit,
}
