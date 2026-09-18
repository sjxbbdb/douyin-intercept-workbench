'use strict'

// client/license/heartbeat.js
//
// 心跳 —— 契约 §4.5。
//
// ⚠️ 心跳看起来只是"证明还在线"，实际上它承担三件**安全必需**的事：
//    1. **策略下发**：服务端收紧限额（风控发现异常）只能通过心跳到达客户端，
//       且客户端必须在 **60 秒内**切换。心跳停了 = 服务端失去干预能力。
//    2. **停机指令**：`pause_engine` / `circuit_break` 是服务端唯一能让
//       客户端立刻停手的手段。漏执行 = 账号在风控期内继续发送。
//    3. **策略 ack**：客户端必须回报**实际生效**的上限（而不只是"我收到了"）。
//       这是红线 3 在运行期的落点——纠纷时要能证明"当时实际生效多少"。
//
// ⚠️ 心跳**不参与计费**（契约 §6.1 明确）。`online_seconds` 只用于运营统计。
//    任何把它换算成积分的行为都是对 v1 计费模型的回退，明令作废。
//
// ⚠️ 幂等：同一 `seq` 重复提交返回与首次相同的响应（服务端缓存 10 分钟）。
//    因此**网络超时后可以安全重发同一个 seq**——但 seq 已经落盘推进过了，
//    本模块不回收序号，重发时用新序号即可（浪费一个号码，比回退安全）。

const { PATHS, MS_PER_DAY } = require('../../shared/lib/protocol')
const { AppError } = require('../../shared/lib/errors')
const keys = require('./keys')

/** 心跳通道名（契约 §5.4 的序号通道） */
const CHANNEL = 'heartbeat'

/** 离线退避的上限（契约 §9.3：1s/2s/4s/8s…上限 60 秒） */
const MAX_BACKOFF_MS = 60000

class Heartbeat {
  /**
   * @param {object} opts
   * @param {object} opts.http
   * @param {object} opts.state
   * @param {object} opts.auth
   * @param {object} opts.guard          安全护栏（提供 applied_limits 的权威值）
   * @param {string} opts.clientVersion
   * @param {object} [opts.logger]
   * @param {() => object} [opts.getEngineSnapshot] 返回 {engine_state, instances, daily_used, pending_send_count, last_error_code}
   */
  constructor(opts) {
    if (!opts || !opts.http || !opts.state || !opts.auth) {
      throw new Error('Heartbeat 需要 http / state / auth')
    }
    this.http = opts.http
    this.state = opts.state
    this.auth = opts.auth
    this.guard = opts.guard || null
    this.clientVersion = opts.clientVersion || '0.0.0'
    this.logger = opts.logger || null
    this.getEngineSnapshot = opts.getEngineSnapshot || (() => ({ engine_state: 'idle' }))

    this.startedAtMs = Date.now()
    this.monotonicBaseMs = nowMonotonic()

    /** 连续失败次数（用于退避） */
    this.failures = 0
    /** 最近一次服务端下发的命令（供上层消费） */
    this.lastCommands = []
    /** 由服务端下发的下一次心跳间隔 */
    this.nextIntervalMs = 60000
    /** 熔断状态（服务端视角） */
    this.serverCircuit = null
    /** 状态：active / degraded / idle / exhausted / suspended */
    this.serverState = null

    /** 已下发但上层尚未执行的停机类命令（避免上层漏读） */
    this.pendingStop = null
  }

  #log(level, msg, detail) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](msg, detail)
  }

  /**
   * 组装心跳请求体（契约 §4.5 字段表）。
   *
   * ⚠️ `applied_limits` 必须来自**护栏**（实际生效值），而不是服务端 policy。
   *    两者可能不同：商家可以在客户端调得更保守。若回报的是服务端值，
   *    就丢失了"用户主动调低过"这一事实——而审计恰恰要证明这个（红线 3）。
   */
  buildPayload() {
    const s = this.state
    const snap = this.getEngineSnapshot()
    const ws = this.guard ? this.guard.snapshot() : { limits: {}, used: {}, sending_enabled: false }

    const appliedLimits = {}
    for (const src of ['comment', 'live_danmaku', 'dm']) {
      const l = ws.limits[src] || {}
      appliedLimits[src] = {
        daily_max: Number(l.daily_max || 0),
        min_interval_ms: Number(l.min_interval_ms || 0),
        content_similarity_max: l.content_similarity_max === undefined ? null : l.content_similarity_max,
      }
    }
    // ⚠️ 活跃时段在 policy 顶层（`policy.active_hours`），不在 limits 里。
    //    少回报这一项，会让服务端无法发现"客户端自己加了禁发时段"——
    //    虽然那更保守、不需要拦，但审计要求"实际生效值"完整（红线 3）。
    const activeHours = this.guard && this.guard.policy ? this.guard.policy.active_hours : null
    if (activeHours) {
      appliedLimits.active_hours = activeHours
    }
    // ⚠️ **不要**在 applied_limits 里加 `sending_enabled` 之类的额外键。
    //    服务端的 validateClientLimits 对键名走白名单
    //    （已知渠道 + `active_hours`），未知键直接抛 POLICY_TIER_UNKNOWN。
    //    而心跳里那个异常会被归类为"越权上报"，后果是：
    //      · 每次心跳都被记为一次违规（举证数据被污染）
    //      · **policy_ack_log 永远写不进去**（代码里 ack 与 violation 互斥）
    //    也就是红线 3 的存证链会静默断裂。sending_enabled 是服务端的
    //    判定结果，不是客户端可调的配置，本就不该出现在这里。

    const ap = this.auth.appliedPolicyFields()

    return {
      account_id: s.accountId,
      device_id: s.ensureDeviceId(),
      // ⚠️ `instance_id` 不在契约 §4.5 的字段表里，但服务端用它给
      //    `policy_ack_log` 做分区键（UNIQUE(account_id, instance_id,
      //    policy_version)）。不传的后果是 **ack 存证写不进去**，
      //    而这张表正是红线 3 要求"能回答当时实际生效策略"的依据。
      //    登录响应会下发 `instance_id`，这里原样回带。
      instance_id: s.instanceIdValue,
      session_id: s.sessionId,
      seq: s.nextSeq(CHANNEL),
      client_version: this.clientVersion,
      protocol_version: 2,
      engine_state: snap.engine_state || 'idle',
      online_seconds: Math.floor((Date.now() - this.startedAtMs) / 1000),
      monotonic_ms: Math.round(nowMonotonic() - this.monotonicBaseMs),
      wall_clock_ms: Date.now(),
      // ⚠️ `client_time_ms` 是服务端算 `clock_skew_ms` 的输入（见 routes-audit
      //    的 `nowMs - body.client_time_ms`）。不发它，服务端就只能回 0，
      //    于是客户端**无法从心跳自愈时钟偏差**——而偏差一旦超过 ±5 分钟，
      //    所有请求都会 401 AUTH_TS_SKEW，且那时响应未签名、拿不到
      //    server_time_ms，客户端会卡死在"登录成功但什么都做不了"。
      client_time_ms: Date.now(),
      clock_skew_ms: Number(this.http.clockSkewMs || 0),
      applied_policy_version: ap.applied_policy_version,
      applied_policy_hash: ap.applied_policy_hash,
      applied_limits: appliedLimits,
      daily_used: {
        comment: Number(ws.used.comment || 0),
        live_danmaku: Number(ws.used.live_danmaku || 0),
        dm: Number(ws.used.dm || 0),
      },
      pending_send_count: Number(snap.pending_send_count || 0),
      instances: Array.isArray(snap.instances) ? snap.instances : [],
      last_error_code: snap.last_error_code || null,
    }
  }

  /**
   * 发一次心跳。
   *
   * @returns {Promise<{body:object, commands:Array, policyChanged:boolean, stopRequested:boolean}>}
   */
  async send() {
    if (!this.state.isLoggedIn) {
      throw new AppError('AUTH_TOKEN_MISSING', '尚未登录，心跳已跳过')
    }
    if (!this.state.sessionId) this.state.startSession()

    const payload = this.buildPayload()
    const res = await this.http.request({ method: 'POST', path: PATHS.heartbeat, body: payload })
    const b = res.body || {}

    this.failures = 0
    this.serverState = b.state || this.serverState
    this.serverCircuit = b.circuit_breaker || null
    if (b.next_heartbeat_after_ms) {
      this.nextIntervalMs = Math.max(10000, Number(b.next_heartbeat_after_ms))
    } else if (this.http.limits && this.http.limits.heartbeat_interval_ms) {
      this.nextIntervalMs = Number(this.http.limits.heartbeat_interval_ms)
    }

    // ── ① 密钥轮换（契约为 §5.4）──────────────────────────
    this.auth.adoptRotation(b)

    // ── ② 策略下发：必须在 60 秒内切换 ────────────────────
    const policyChanged = b.policy_changed === true
    if (policyChanged && b.policy) {
      this.state.adoptPolicy(b.policy)
      if (this.guard) {
        // ⚠️ 护栏采纳服务端策略时会丢弃"比服务端更激进"的自定义值，
        //    并把这些冲突返回——冲突本身就是"用户曾试图越权"的证据，
        //    必须写审计（红线 3），不能丢。
        const r = this.guard.applyPolicy(b.policy)
        if (r.dropped_overrides && r.dropped_overrides.length) {
          this.#log('warn', 'overrides_dropped', { dropped: r.dropped_overrides })
          if (this.onOverridesDropped) this.onOverridesDropped(r.dropped_overrides, b.policy)
        }
      }
      this.#log('info', 'policy_changed', {
        policy_version: b.policy.policy_version,
        account_tier: b.policy.account_tier,
        limits: b.policy.limits,
      })
    } else if (b.policy && !this.state.policy) {
      // 首次拿到策略（登录响应里没有，或走了离线恢复路径）
      this.state.adoptPolicy(b.policy)
      if (this.guard) this.guard.applyPolicy(b.policy)
    }

    // ── ③ ack 状态：只有在本轮已回报了新版本后才算 ack 完成 ──
    const appliedVersion = payload.applied_policy_version
    const serverVersion = b.policy ? Number(b.policy.policy_version) : null
    if (serverVersion !== null && appliedVersion === serverVersion) {
      this.state.markPolicyAcked(serverVersion)
    }

    // ── ④ 服务端命令 ──────────────────────────────────────
    const commands = Array.isArray(b.commands) ? b.commands : []
    this.lastCommands = commands
    const stop = this.#applyCommands(commands)
    if (stop) this.pendingStop = stop

    // ── ⑤ 配额与余额 ──────────────────────────────────────
    this.state.adoptHeartbeatResult(b)

    return {
      body: b,
      commands,
      policyChanged,
      stopRequested: Boolean(stop),
      stop,
    }
  }

  /**
   * 解释服务端命令。
   *
   * ⚠️ 契约 §4.5 要求客户端在 **60 秒内**执行 `pause_engine` 与
   *    `circuit_break`。所以本方法**只做解释与落状态**，
   *    真正的停机动作交给上层（它才知道怎么停引擎）——
   *    但会通过返回值 + `pendingStop` 双通道告知，避免上层漏读。
   *
   * @returns {object|null} 需要停机时返回停机指令
   */
  #applyCommands(commands) {
    let stop = null
    for (const c of commands) {
      if (!c || typeof c !== 'object') continue
      switch (c.type) {
        case 'pause_engine':
          stop = {
            action: 'pause',
            reason: c.reason || 'SERVER_COMMAND',
            at_ms: Date.now(),
          }
          break
        case 'circuit_break':
          stop = {
            action: 'pause',
            reason: 'POLICY_CIRCUIT_OPEN',
            cooldown_until_ms: Number(c.cooldown_until_ms || 0) || null,
            at_ms: Date.now(),
          }
          break
        case 'resume_engine':
          // ⚠️ 清除待执行停机指令，但**不主动恢复**：是否恢复由上层决定
          //    （它还要看余额、观察期、熔断等本地条件）。
          this.pendingStop = null
          break
        case 'reload_policy':
          // 上层应拉 GET /policy/current。这里不代做，避免心跳里嵌套请求
          // 导致超时叠加。
          this.needsPolicyReload = true
          break
        case 'throttle':
          if (c.limits && this.guard) {
            // ⚠️ throttle 是"进一步收紧"，必须走护栏的采纳路径
            //    （它会拒绝任何比现有策略更激进的合并）。
            const merged = mergeThrottle(this.guard.policy, c.limits)
            if (merged) {
              this.guard.applyPolicy(merged)
              this.state.adoptPolicy(merged)
            }
          }
          break
        case 'force_upgrade':
          stop = {
            action: 'stop',
            reason: 'SERVER_VERSION_UNSUPPORTED',
            upgrade_url: c.url || null,
            at_ms: Date.now(),
          }
          break
        default:
          // ⚠️ 未知命令必须留痕。契约 §8.2 说明新命令可能先于客户端上线，
          //    静默忽略会让"服务端下了停机指令但客户端没停"无从发现。
          this.#log('warn', 'unknown_command', { type: c.type })
      }
    }
    return stop
  }

  /**
   * 消费待执行的停机指令（上层在主循环里调用）。
   * @returns {object|null}
   */
  consumeStop() {
    const s = this.pendingStop
    this.pendingStop = null
    return s
  }

  /** 供调度器决定下次心跳的等待时长（含指数退避）。 */
  nextDelayMs() {
    if (this.failures === 0) return this.nextIntervalMs
    return Math.min(1000 * 2 ** Math.min(this.failures, 6), MAX_BACKOFF_MS)
  }

  /** 记录一次失败（上层捕获异常后调用），用于退避。 */
  recordFailure(e) {
    this.failures += 1
    this.#log('warn', 'heartbeat_failed', {
      failures: this.failures,
      code: e && e.code,
      next_delay_ms: this.nextDelayMs(),
    })
    return this.nextDelayMs()
  }

  /**
   * 离线时长（用于 degraded 判定，契约 §9.3）：
   *   距上次成功心跳超过 `offline_send_grace_ms`(15min) → 进入 degraded。
   */
  offlineForMs(atMs) {
    const last = Number(this.state.state.lastHeartbeatMs || 0)
    if (!last) return null
    const now = atMs === undefined ? Date.now() : atMs
    return Math.max(0, now - last)
  }
  /** 是否已超出"离线仍可发送"的宽限（契约 §9.3 的 15 分钟）。 */
  isBeyondOfflineGrace(atMs) {
    const grace = this.#limit('offline_send_grace_ms', 900000)
    const off = this.offlineForMs(atMs)
    return off !== null && off > grace
  }

  /**
   * 是否已超出会话宽限（契约 §9.3 第 5 条：离线超过 `grace_ms`(24h) →
   * 进入暂停态，只保留采集与心跳重试）。
   */
  isBeyondSessionGrace(atMs) {
    const grace = this.#limit('grace_ms', MS_PER_DAY)
    const off = this.offlineForMs(atMs)
    return off !== null && off > grace
  }

  #limit(name, fallback) {
    const l = this.http.limits
    return l && Number.isFinite(Number(l[name])) ? Number(l[name]) : fallback
  }

  /**
   * 计算当前时钟偏移是否需要重新校准。
   * ⚠️ 契约 §5.4：偏移超过 `sign_ts_tolerance_ms`(300000) 会导致**所有**
   *    请求 401。心跳每次都会带回 `server_time_ms`（在 http 层已校准），
   *    所以正常运行时不会累积到这个程度；这里只是给上层一个可展示的告警。
   */
  clockSkewWarning(thresholdMs) {
    const limit = thresholdMs || this.#limit('sign_ts_tolerance_ms', 300000)
    const skew = Math.abs(Number(this.http.clockSkewMs || 0))
    if (skew <= limit * 0.6) return null
    return {
      clock_skew_ms: Number(this.http.clockSkewMs || 0),
      threshold_ms: limit,
      hint: '本机时钟与服务端偏差较大，可能导致请求被拒。建议开启系统时间自动同步。',
    }
  }
}

/**
 * 合并 `throttle` 命令下发的限额。
 *
 * ⚠️ 只能**收紧**。服务端如果因为 bug 下发了更宽松的值，
 *    客户端也必须拒绝——这是红线 1 在客户端的最后一道自主防线。
 */
function mergeThrottle(policy, newLimits) {
  if (!policy || !policy.limits || !newLimits) return null
  const out = { ...policy, limits: {} }
  let changed = false
  for (const [src, cur] of Object.entries(policy.limits)) {
    const next = newLimits[src]
    if (!next) { out.limits[src] = cur; continue }
    const merged = { ...cur }
    for (const [field, v] of Object.entries(next)) {
      if (cur[field] === undefined) { merged[field] = v; changed = true; continue }
      const tighter = tighterOf(field, cur[field], v)
      if (tighter !== cur[field]) changed = true
      merged[field] = tighter
    }
    out.limits[src] = merged
  }
  return changed ? out : null
}

function tighterOf(field, a, b) {
  switch (field) {
    case 'daily_max': return Math.min(Number(a), Number(b))
    case 'min_interval_ms': return Math.max(Number(a), Number(b))
    case 'content_similarity_max': return Math.min(Number(a), Number(b))
    default: return a // 未知字段保持原值，不采纳服务端新值
  }
}

/** 单调时钟（不受系统时间调整影响，用于排查"墙上时间跳变"）。 */
function nowMonotonic() {
  const [s, ns] = process.hrtime()
  return s * 1000 + ns / 1e6
}

module.exports = {
  Heartbeat,
  CHANNEL,
  MAX_BACKOFF_MS,
  mergeThrottle,
  tighterOf,
  nowMonotonic,
}
