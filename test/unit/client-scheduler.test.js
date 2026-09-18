'use strict'

// test/unit/client-scheduler.test.js
// 调度器测试 —— **调度器只问护栏，不自己判限额**。
//
// ⚠️ 本文件最重要的两条命题：
//   ① 调度器**不得**在护栏拒绝时发送任何东西（红线 1 的执行面）
//   ② `stop()` 必须清掉**全部**定时器。漏一个的表现是"界面显示已停止，
//      但后台还在发"——最危险，因为商家以为自己按了停。
//
// ⚠️ 刻意用**真实的 Guard + 真实策略**（buildPolicy），只把网络与平台
//    动作替换成假件。护栏是真命题的载体，用假的就测不出"只问护栏"。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { Store } = require('../../client/host/store')
const { Queue } = require('../../client/host/queue')
const { Scheduler, RETRYABLE_CODES } = require('../../client/host/scheduler')
const G = require('../../client/safety/guard')
const { buildPolicy } = require('../../license-server/domain/policy')

const NOW = 1758096000000
const TZ = 480 * 60 * 1000

/** 本地时间某日某刻（UTC+8），默认 10:00 落在活跃时段 08:00–23:00 内。 */
function localTime(dayOffset = 0, hour = 10, minute = 0) {
  const day = Math.floor((NOW + TZ) / 86400000) + dayOffset
  return day * 86400000 + (hour * 60 + minute) * 60000 - TZ
}
const BASE = localTime(0, 10, 0)

function stablePolicy() {
  return buildPolicy({ accountId: 1, accountDayIndex: 30, policyVersion: 9, nowMs: NOW })
}
function obsPolicy() {
  return buildPolicy({ accountId: 1, accountDayIndex: 1, policyVersion: 9, nowMs: NOW })
}

/** 心跳假件：可控返回、记录调用次数。 */
function fakeHeartbeat() {
  return {
    calls: 0,
    next: {
      body: { ok: true, state: 'active', credit: { balance_milli: 100000 }, daily_quota: {} },
      commands: [], policyChanged: false, stopRequested: false, stop: null,
    },
    throwNext: null,
    needsPolicyReload: false,
    async send() {
      this.calls += 1
      if (this.throwNext) { const e = this.throwNext; this.throwNext = null; throw e }
      return this.next
    },
    recordFailure() { return 1000 },
    clockSkewWarning() { return null },
  }
}

function fakeReporter() {
  return {
    sendsCalls: 0,
    usageCalls: 0,
    nextSends: null,
    async reportSends() { this.sendsCalls += 1; return this.nextSends },
    async reportUsage() { this.usageCalls += 1; return { ok: true } },
  }
}

function fakeAuth() {
  // ⚠️ 用真实的 LicenseAuth 静态方法，避免测试里出现"两周后实现变了但测试还绿"
  const { LicenseAuth } = require('../../client/license/auth')
  return {
    constructor: LicenseAuth,
    invalid: null,
    markCredentialInvalid(code, detail) { this.invalid = { code, detail } },
  }
}

function makeCtx(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sched-'))
  const store = new Store({ dir })
  let t = opts.nowMs === undefined ? BASE : opts.nowMs
  const guard = new G.Guard({ store, now: () => t })
  const queue = new Queue({ store, now: () => t })
  const heartbeat = fakeHeartbeat()
  const reporter = fakeReporter()
  const auth = fakeAuth()
  const executed = []
  const executor = opts.executor || (async (task) => {
    executed.push(task)
    return { outcome: 'done', verdict: 'sent_confirmed', userKeyHash: 'uh-1' }
  })

  const scheduler = new Scheduler({
    store, guard, queue, auth, heartbeat, reporter, executor,
    now: () => t,
  })

  return {
    dir, store, guard, queue, heartbeat, reporter, auth, scheduler, executed,
    at: () => t,
    setTime: (v) => { t = v },
    cleanup: () => {
      scheduler.stop('test_cleanup')
      store.close()
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    },
  }
}

function task(overrides = {}) {
  return {
    kind: 'reply_comment',
    sourceType: 'comment',
    dedupKey: overrides.dedupKey || `dk-${Math.random().toString(16).slice(2, 10)}`,
    payload: {},
    ...overrides,
  }
}

/** 跑一轮任务循环。调度器为此提供了公开的一次性入口，测试无需依赖定时器。 */
async function runTaskCycle(h) {
  await h.scheduler.runTaskCycleOnce()
}

// ══════════════════════════════════════════════════════════
// 幂等启动（D-13）
// ══════════════════════════════════════════════════════════

test('调度器：重复 start 幂等，不会起两套定时器', () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    const a = h.scheduler.start()
    assert.strictEqual(a.started, true)
    const timersAfterFirst = h.scheduler.snapshot().timers.length

    const b = h.scheduler.start()
    assert.strictEqual(b.started, false)
    assert.strictEqual(b.reason, 'already_running')
    assert.strictEqual(h.scheduler.snapshot().timers.length, timersAfterFirst,
      '重复启动不得多出定时器——否则心跳翻倍、任务被处理两次')
  } finally { h.cleanup() }
})

test('调度器：磁盘运行锁 —— 另一个新实例在旧实例心跳新鲜时拒绝启动', () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.scheduler.start()

    // ⚠️ 模拟"另一个进程"：伪造一个别人持有的、心跳很新的锁。
    //    不能真的起两个进程（测试环境不便），但锁的判据是纯数据，等价。
    h.store.update('runtime-state.json', {}, (s) => {
      s.schedulerPid = process.pid + 12345
      s.schedulerHeartbeatMs = h.at()
      return s
    })
    // 让第一个调度器停下（它会释放自己的锁），再用新实例尝试启动
    h.scheduler.stop('test')
    h.store.update('runtime-state.json', {}, (s) => {
      s.schedulerPid = process.pid + 12345
      s.schedulerHeartbeatMs = h.at()
      return s
    })

    const other = new Scheduler({
      store: h.store, guard: h.guard, queue: h.queue, auth: h.auth,
      heartbeat: h.heartbeat, reporter: h.reporter, executor: async () => ({ outcome: 'done' }),
      now: () => h.at(),
    })
    const r = other.start()
    assert.strictEqual(r.started, false)
    assert.strictEqual(r.reason, 'another_instance_running')
  } finally { h.cleanup() }
})

test('调度器：陈旧运行锁不阻断启动（pid 会被复用，拒绝会让人打不开程序）', () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.store.update('runtime-state.json', {}, (s) => {
      s.schedulerPid = process.pid + 12345
      s.schedulerHeartbeatMs = h.at() - 10 * 60000 // 10 分钟没心跳 = 早就死了
      return s
    })
    const r = h.scheduler.start()
    assert.strictEqual(r.started, true, '陈旧锁必须放行')
  } finally { h.cleanup() }
})

test('调度器：stop 清空全部定时器，且重复 stop 幂等', () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.scheduler.start()
    assert.ok(h.scheduler.snapshot().timers.length > 0)

    const r1 = h.scheduler.stop('user')
    assert.strictEqual(r1.stopped, true)
    assert.strictEqual(r1.wasRunning, true)
    assert.deepStrictEqual(h.scheduler.snapshot().timers, [],
      '必须一个不剩——漏一个就会出现"显示已停止但后台还在发"')
    assert.strictEqual(h.scheduler.state, 'stopped')

    const r2 = h.scheduler.stop('again')
    assert.strictEqual(r2.wasRunning, false, '重复停止应幂等')
  } finally { h.cleanup() }
})

test('调度器：stop 后释放运行锁（否则下次启动被自己的锁挡住）', () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.scheduler.start()
    h.scheduler.stop('done')
    const st = h.store.readJson('runtime-state.json', {})
    assert.strictEqual(Number(st.schedulerPid || 0), 0, '必须释放锁')
    assert.ok(Number(st.schedulerStoppedAtMs || 0) > 0)
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 护栏是唯一准入判定（红线 1）
// ══════════════════════════════════════════════════════════

test('调度器：观察期护栏拒绝时，执行器一次都不被调用', async () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(obsPolicy())
    h.queue.add(task())
    h.scheduler.state = 'running' // 直接置位，跳过定时器
    await runTaskCycle(h)

    assert.strictEqual(h.executed.length, 0, '观察期不得发送任何东西')
    assert.strictEqual(h.queue.stats().queued, 1, '任务必须放回待办，不能被判失败')
    assert.strictEqual(h.scheduler.stats.blockedBy, 'sending_disabled')
  } finally { h.cleanup() }
})

test('调度器：日上限用尽后停止取任务（且任务留在队列）', async () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    // 稳定期评论上限 30：先把额度用满
    for (let i = 0; i < 30; i++) h.guard.recordSent({ sourceType: 'comment', atMs: BASE + i * 61000 })
    h.setTime(BASE + 30 * 61000)
    h.queue.add(task())
    h.scheduler.state = 'running'
    await runTaskCycle(h)

    assert.strictEqual(h.executed.length, 0, '额度用尽后不得发送')
    assert.strictEqual(h.queue.stats().queued, 1)
    assert.strictEqual(h.scheduler.stats.blockedBy, 'daily_cap_exceeded')
  } finally { h.cleanup() }
})

test('调度器：未采纳策略时 fail-closed，不发送', async () => {
  const h = makeCtx()
  try {
    // 刻意不 applyPolicy
    h.queue.add(task())
    h.scheduler.state = 'running'
    await runTaskCycle(h)
    assert.strictEqual(h.executed.length, 0, '没有服务端策略就没有依据，必须停发')
  } finally { h.cleanup() }
})

test('调度器：急停立即生效，排队任务不得绕过', async () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.guard.setEmergencyStop(true, '用户急停')
    h.queue.add(task())
    h.scheduler.state = 'running'
    await runTaskCycle(h)
    assert.strictEqual(h.executed.length, 0)
    assert.strictEqual(h.scheduler.stats.blockedBy, 'emergency_stop')
  } finally { h.cleanup() }
})

test('调度器：允许时正常执行一条，并记入护栏日用量与去重历史', async () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.queue.add(task({ dedupKey: 'dk-ok', sourceType: 'comment' }))
    h.scheduler.state = 'running'
    await runTaskCycle(h)

    assert.strictEqual(h.executed.length, 1)
    const st = h.queue.stats()
    assert.strictEqual(st.done, 1)
    assert.strictEqual(h.guard.usedToday('comment', BASE), 1, '护栏日用量必须 +1')
    assert.strictEqual(h.queue.hasReplied('dk-ok'), true, '必须记入去重历史')
    assert.strictEqual(h.queue.userRepliedWithin('uh-1', 86400000, BASE), true)
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 任务结果处理
// ══════════════════════════════════════════════════════════

test('调度器：平台明确失败 → 计失败并触发护栏结果记录', async () => {
  const h = makeCtx({
    executor: async () => ({ outcome: 'failed', verdict: 'failed', failureReason: 'risk_control_rejected' }),
  })
  try {
    h.guard.applyPolicy(stablePolicy())
    h.queue.add(task())
    h.scheduler.state = 'running'
    await runTaskCycle(h)
    assert.strictEqual(h.queue.stats().failed, 1)
    assert.strictEqual(h.scheduler.stats.tasksFailed, 1)
  } finally { h.cleanup() }
})

test('调度器：skipped 不算失败、不计熔断（"用户已回复过"不是异常）', async () => {
  const h = makeCtx({
    executor: async () => ({ outcome: 'skipped', reason: 'user_replied_within_window' }),
  })
  try {
    h.guard.applyPolicy(stablePolicy())
    h.queue.add(task())
    h.scheduler.state = 'running'
    await runTaskCycle(h)
    assert.strictEqual(h.queue.stats().skipped, 1)
    assert.strictEqual(h.queue.stats().failed, 0)
    assert.strictEqual(h.guard.circuit.level, 'none',
      '跳过绝不能累积成熔断——否则"正常跳过"会把账号无谓停掉')
  } finally { h.cleanup() }
})

test('调度器：可重试故障（标签页丢失）→ 放回队列而不是判失败', async () => {
  const h = makeCtx({
    executor: async () => { const e = new Error('tab gone'); e.code = 'TAB_LOST'; throw e },
  })
  try {
    h.guard.applyPolicy(stablePolicy())
    h.queue.add(task())
    h.scheduler.state = 'running'
    await runTaskCycle(h)
    assert.strictEqual(h.queue.stats().queued, 1, '可重试故障必须放回——自愈率靠它')
    assert.strictEqual(h.queue.stats().failed, 0)
    assert.strictEqual(h.scheduler.stats.tasksRequeued, 1)
    assert.ok(RETRYABLE_CODES.includes('TAB_LOST'))
  } finally { h.cleanup() }
})

test('调度器：DOM 判据（sent_confirmed_dom）也占本地日额度', async () => {
  const h = makeCtx({
    executor: async () => ({ outcome: 'done', verdict: 'sent_confirmed_dom', userKeyHash: 'uh-d' }),
  })
  try {
    h.guard.applyPolicy(stablePolicy())
    h.queue.add(task())
    h.scheduler.state = 'running'
    await runTaskCycle(h)
    // ⚠️ 平台那边它已经发生了，不占额度会让第二天超发。
    assert.strictEqual(h.guard.usedToday('comment', BASE), 1)
  } finally { h.cleanup() }
})

test('调度器：执行器返回空 → 计失败而不是静默成功', async () => {
  const h = makeCtx({ executor: async () => undefined })
  try {
    h.guard.applyPolicy(stablePolicy())
    h.queue.add(task())
    h.scheduler.state = 'running'
    await runTaskCycle(h)
    assert.strictEqual(h.queue.stats().failed, 1)
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 暂停 / 恢复 / 熔断
// ══════════════════════════════════════════════════════════

test('调度器：pauseUntil 暂停发送，到期后需护栏点头才恢复', async () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.scheduler.state = 'running'
    h.scheduler.pauseUntil(BASE + 60000, 'CREDIT_EXHAUSTED')
    assert.strictEqual(h.scheduler.isSendWindowOpen().open, false)

    h.queue.add(task())
    await runTaskCycle(h)
    assert.strictEqual(h.executed.length, 0, '暂停期内不得发送')

    h.setTime(BASE + 61000)
    await runTaskCycle(h)
    assert.strictEqual(h.executed.length, 1, '到期且护栏允许后应恢复')
    assert.strictEqual(h.scheduler.state, 'running')
  } finally { h.cleanup() }
})

test('调度器：服务端熔断冷却比本地短时，取本地（更长）的那个', async () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.scheduler.state = 'running'
    // 本地已升到 L2（1 小时）
    h.guard.circuit.level = 'l2'
    h.guard.circuit.untilMs = BASE + 3600000

    h.heartbeat.next = {
      body: {
        ok: true, state: 'active',
        circuit_breaker: { open: true, cooldown_until_ms: BASE + 300000, trigger: 'failure_rate' },
      },
      commands: [], policyChanged: false, stopRequested: false, stop: null,
    }
    await h.scheduler.runHeartbeatOnce() // 私有方法：同进程内可直接触达
    assert.strictEqual(h.scheduler.pausedUntilMs, BASE + 3600000,
      '服务端给得更短时绝不能把本地级别降下来')
  } finally { h.cleanup() }
})

test('调度器：服务端要求停机（action=stop）→ 调度器停止运行', async () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.scheduler.state = 'running'
    h.heartbeat.next = {
      body: { ok: true, state: 'active' },
      commands: [{ type: 'force_upgrade', url: 'https://x' }],
      policyChanged: false, stopRequested: true,
      stop: { action: 'stop', reason: 'SERVER_VERSION_UNSUPPORTED' },
    }
    await h.scheduler.runHeartbeatOnce()
    assert.strictEqual(h.scheduler.state, 'stopped')
  } finally { h.cleanup() }
})

test('调度器：余额耗尽（state=exhausted）→ 立即暂停发送', async () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.scheduler.state = 'running'
    h.heartbeat.next = {
      body: { ok: true, state: 'exhausted', credit: { balance_milli: -700 } },
      commands: [{ type: 'pause_engine', reason: 'CREDIT_EXHAUSTED' }],
      policyChanged: false, stopRequested: true,
      stop: { action: 'pause', reason: 'CREDIT_EXHAUSTED' },
    }
    await h.scheduler.runHeartbeatOnce()
    assert.strictEqual(h.scheduler.state, 'paused')
    h.queue.add(task())
    await runTaskCycle(h)
    assert.strictEqual(h.executed.length, 0, '余额耗尽后不得再发')
  } finally { h.cleanup() }
})

test('调度器：心跳遇身份类错误 → 停止并标记凭据失效（而不是反复重试）', async () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.scheduler.start()
    const e = new Error('revoked'); e.code = 'AUTH_TOKEN_REVOKED'
    h.heartbeat.throwNext = e
    await h.scheduler.runHeartbeatOnce()
    assert.strictEqual(h.scheduler.state, 'stopped')
    assert.strictEqual(h.auth.invalid.code, 'AUTH_TOKEN_REVOKED')
  } finally { h.cleanup() }
})

test('调度器：心跳遇网络故障 → 退避重试，不停止运行', async () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.scheduler.start()
    const e = new Error('offline'); e.code = 'SERVER_UNAVAILABLE'
    h.heartbeat.throwNext = e
    const before = h.scheduler.state
    await h.scheduler.runHeartbeatOnce()
    assert.strictEqual(before, 'running')
    assert.strictEqual(h.scheduler.state, 'running', '网络故障不得停机（离线仍要继续采集）')
    assert.strictEqual(h.scheduler.stats.heartbeatFailures, 1)
    assert.strictEqual(h.auth.invalid, null)
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 聚合窗口
// ══════════════════════════════════════════════════════════

test('调度器：聚合窗口把 skipped 记在 skipped 字段，verdict 记在判定字段（不得混用）', () => {
  const h = makeCtx()
  try {
    h.scheduler.recordHit('comment', { isNewLead: true, uniqueUser: true })
    h.scheduler.countWindow('comment', 'skipped')
    h.scheduler.countWindow('comment', 'sent_confirmed')
    h.scheduler.countWindow('comment', 'failed')

    const s = h.scheduler.window.window.sources.comment
    assert.strictEqual(s.hits, 1)
    assert.strictEqual(s.leads_new, 1)
    assert.strictEqual(s.unique_users, 1)
    assert.strictEqual(s.skipped, 1)
    assert.strictEqual(s.sent_confirmed, 1)
    assert.strictEqual(s.failed, 1)
    assert.strictEqual(s.reply_attempts, 2,
      'reply_attempts 只统计真正的发送尝试（两个 verdict），skipped 不算')
    // ⚠️ 契约 §7.2 的约束：四个 verdict 之和 = reply_attempts
    assert.strictEqual(
      s.sent_confirmed + s.sent_confirmed_dom + s.sent_suspected + s.failed,
      s.reply_attempts
    )
  } finally { h.cleanup() }
})

test('调度器：空窗口不发聚合上报（避免看板出现空窗口）', async () => {
  const h = makeCtx()
  try {
    h.scheduler.state = 'running'
    await h.scheduler.runUsageReportOnce()
    assert.strictEqual(h.reporter.usageCalls, 0)
  } finally { h.cleanup() }
})

test('调度器：有计数则发聚合上报', async () => {
  const h = makeCtx()
  try {
    h.scheduler.state = 'running'
    h.scheduler.recordHit('comment')
    await h.scheduler.runUsageReportOnce()
    assert.strictEqual(h.reporter.usageCalls, 1)
  } finally { h.cleanup() }
})

test('调度器：无明细时上报明细不发请求（契约 §9.1 空批不上报）', async () => {
  const h = makeCtx()
  try {
    h.scheduler.state = 'running'
    h.reporter.nextSends = null
    await h.scheduler.runSendsReportOnce()
    assert.strictEqual(h.reporter.sendsCalls, 1, '循环会调用一次')
    assert.strictEqual(h.scheduler.stats.sendsReports, 0, '但返回 null 时不应计为上报表')
  } finally { h.cleanup() }
})

test('调度器：上报返回 failClosed → 立即停机（契约 §5.4）', async () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.scheduler.state = 'running'
    h.reporter.nextSends = {
      body: null, results: [], settlement: null, accepted: 0, conflicts: [],
      commands: [], error: 'AUTH_SIGN_INVALID', failClosed: true,
    }
    await h.scheduler.runSendsReportOnce()
    assert.strictEqual(h.scheduler.state, 'stopped',
      '验签失败必须停机——链路已被证明不可信')
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 引擎状态（供心跳上报）
// ══════════════════════════════════════════════════════════

test('调度器：快照提供界面与心跳所需的全部字段', () => {
  const h = makeCtx()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.queue.add(task())
    const s = h.scheduler.snapshot()
    assert.strictEqual(s.state, 'stopped')
    assert.strictEqual(s.engine_state, 'stopped')
    assert.strictEqual(s.queue.queued, 1)
    assert.ok(s.guard)
    assert.ok(s.stats)
    assert.strictEqual(typeof s.paused_until_ms, 'number')
  } finally { h.cleanup() }
})
