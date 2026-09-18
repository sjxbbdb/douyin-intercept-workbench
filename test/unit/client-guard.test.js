'use strict'

// test/unit/client-guard.test.js
// 客户端安全护栏测试 —— **红线 1 在客户端的守卫**。
//
// ⚠️ 本文件验证的核心命题是："客户端只能更保守"。
//    任何一项能绕过服务端策略的路径，都意味着商家账号暴露在封号风险里。
//
// ⚠️ 时间用法要点（写测试时踩过）：
//    Guard 的 `now()` 是注入的固定时间，但 `recordSent` / `canSend`
//    **不传 atMs 时会用真实时间**，两者会错位。因此本文件一律显式传 atMs。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { Store } = require('../../client/host/store')
const G = require('../../client/safety/guard')
const { buildPolicy } = require('../../license-server/domain/policy')

const NOW = 1758096000000
const TZ = 480 * 60 * 1000

/** 本地时间某日的某时刻（UTC+8）。默认 10:00 落在活跃时段 08:00-23:00 内。 */
function localTime(dayOffset = 0, hour = 10, minute = 0) {
  const day = Math.floor((NOW + TZ) / 86400000) + dayOffset
  return day * 86400000 + (hour * 60 + minute) * 60000 - TZ
}

/** 测试用的基准时刻 */
const BASE = localTime(0, 10, 0)

/** 稳定期策略（评论 30/天，间隔 60 秒） */
function stablePolicy() {
  return buildPolicy({ accountId: 1, accountDayIndex: 30, policyVersion: 9, nowMs: NOW })
}
/** 观察期策略（全 0，禁发） */
function obsPolicy() {
  return buildPolicy({ accountId: 1, accountDayIndex: 2, policyVersion: 9, nowMs: NOW })
}

function makeGuard(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-guard-'))
  const store = new Store({ dir })
  let t = opts.nowMs === undefined ? BASE : opts.nowMs
  const guard = new G.Guard({ store, now: () => t })
  return {
    guard,
    store,
    dir,
    at: () => t,
    setTime: (v) => { t = v },
    cleanup: () => {
      store.close()
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
    },
  }
}

// ══════════════════════════════════════════════════════════
// fail-closed
// ══════════════════════════════════════════════════════════

test('护栏：尚未取得服务端策略时一律拒绝发送（fail-closed）', () => {
  const h = makeGuard()
  try {
    const r = h.guard.canSend({ sourceType: 'comment' })
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.reason, 'policy_missing')
    // ⚠️ 刻意的：没有服务端策略就没有依据。
    //    "先跑起来再说"会让客户端在无护栏状态下发送。
  } finally { h.cleanup() }
})

test('护栏：采纳策略后可发送', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    const r = h.guard.canSend({ sourceType: 'comment', atMs: BASE })
    assert.strictEqual(r.allow, true)
    assert.strictEqual(r.detail.max, 30)
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 观察期禁发
// ══════════════════════════════════════════════════════════

test('护栏：观察期一律拒绝发送，三渠道全部拒绝', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(obsPolicy())
    for (const s of ['comment', 'live_danmaku', 'dm']) {
      const r = h.guard.canSend({ sourceType: s, atMs: BASE })
      assert.strictEqual(r.allow, false, `${s} 应被拒`)
      assert.strictEqual(r.reason, 'sending_disabled')
    }
    const r = h.guard.canSend({ sourceType: 'comment', atMs: BASE })
    assert.strictEqual(r.detail.account_tier, 'observation')
    assert.match(r.detail.hint, /观察期/)
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// "只能更保守"
// ══════════════════════════════════════════════════════════

test('护栏：daily_max 只能调低', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    assert.doesNotThrow(() => h.guard.setOverride('comment', 'daily_max', 10))
    assert.throws(() => h.guard.setOverride('comment', 'daily_max', 50), /更激进/)
    assert.doesNotThrow(() => h.guard.setOverride('comment', 'daily_max', 30))
  } finally { h.cleanup() }
})

test('护栏：min_interval_ms 只能调高', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    assert.doesNotThrow(() => h.guard.setOverride('comment', 'min_interval_ms', 300000))
    assert.throws(() => h.guard.setOverride('comment', 'min_interval_ms', 1000), /更激进/)
  } finally { h.cleanup() }
})

test('护栏：content_similarity_max 只能调低（方向最易弄反）', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    assert.doesNotThrow(() => h.guard.setOverride('comment', 'content_similarity_max', 0.6))
    assert.throws(() => h.guard.setOverride('comment', 'content_similarity_max', 0.99), /更激进/)
  } finally { h.cleanup() }
})

test('护栏：isMoreConservative 四个方向独立单测', () => {
  assert.strictEqual(G.isMoreConservative('daily_max', 10, 30), true, '上限更低=更保守')
  assert.strictEqual(G.isMoreConservative('daily_max', 50, 30), false)
  assert.strictEqual(G.isMoreConservative('min_interval_ms', 120000, 60000), true, '间隔更长=更保守')
  assert.strictEqual(G.isMoreConservative('min_interval_ms', 1000, 60000), false)
  assert.strictEqual(G.isMoreConservative('content_similarity_max', 0.6, 0.85), true,
    '阈值更低=更容易拒绝=更保守（此处最易弄反）')
  assert.strictEqual(G.isMoreConservative('content_similarity_max', 0.95, 0.85), false)
  assert.strictEqual(G.isMoreConservative('unknown_field', 1, 2), false, '未知字段一律拒绝')
})

test('护栏：越权的自定义值被丢弃并回报（不给配置文件钻空子）', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.guard.setOverride('comment', 'daily_max', 5)
    // 模拟配置文件被改成更激进的值
    h.guard.overrides['comment.daily_max'] = 999
    const res = h.guard.applyPolicy(stablePolicy())
    assert.ok(res.dropped_overrides.includes('comment.daily_max'), '越权值必须被丢弃')
    assert.strictEqual(h.guard.effectiveLimits('comment').daily_max, 30, '退回服务端值')
  } finally { h.cleanup() }
})

test('护栏：实际生效值取"更保守者"', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.guard.setOverride('comment', 'daily_max', 10)
    h.guard.setOverride('comment', 'min_interval_ms', 300000)
    const eff = h.guard.effectiveLimits('comment')
    assert.strictEqual(eff.daily_max, 10)
    assert.strictEqual(eff.min_interval_ms, 300000)
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 日上限
// ══════════════════════════════════════════════════════════

test('护栏：达到日上限后拒绝', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.guard.setOverride('comment', 'daily_max', 3)

    for (let i = 0; i < 3; i++) {
      const at = BASE + i * 61000
      const r = h.guard.canSend({ sourceType: 'comment', atMs: at })
      assert.strictEqual(r.allow, true, `第 ${i + 1} 条应允许（reason=${r.reason}）`)
      h.guard.recordSent({ sourceType: 'comment', atMs: at })
    }

    const r = h.guard.canSend({ sourceType: 'comment', atMs: BASE + 3 * 61000 })
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.reason, 'daily_cap_exceeded')
    assert.strictEqual(r.detail.used, 3)
    assert.strictEqual(r.detail.max, 3)
  } finally { h.cleanup() }
})

test('护栏：三渠道日上限相互独立', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.guard.setOverride('comment', 'daily_max', 1)

    h.guard.recordSent({ sourceType: 'comment', atMs: BASE })

    assert.strictEqual(h.guard.canSend({ sourceType: 'comment', atMs: BASE }).reason, 'daily_cap_exceeded')
    assert.strictEqual(h.guard.canSend({ sourceType: 'live_danmaku', atMs: BASE }).allow, true,
      '评论满了不应影响弹幕')
    assert.strictEqual(h.guard.canSend({ sourceType: 'dm', atMs: BASE }).allow, true)
  } finally { h.cleanup() }
})

test('护栏：跨日自动归零', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.guard.setOverride('comment', 'daily_max', 1)
    h.guard.recordSent({ sourceType: 'comment', atMs: BASE })
    assert.strictEqual(h.guard.canSend({ sourceType: 'comment', atMs: BASE }).reason, 'daily_cap_exceeded')

    const nextDay = localTime(1, 10, 0)
    const r = h.guard.canSend({ sourceType: 'comment', atMs: nextDay })
    assert.strictEqual(r.allow, true, '新的一天应重置额度')
    assert.strictEqual(r.detail.used, 0)
  } finally { h.cleanup() }
})

test('护栏：日上限按 UTC+8 自然日切分（与服务端同口径）', () => {
  const h = makeGuard({ nowMs: localTime(0, 23, 59) })
  try {
    h.guard.applyPolicy(stablePolicy())
    h.guard.recordSent({ sourceType: 'comment', atMs: localTime(0, 23, 59) })
    assert.strictEqual(h.guard.usedToday('comment', localTime(0, 23, 59)), 1)
    assert.strictEqual(h.guard.usedToday('comment', localTime(1, 0, 1)), 0, '跨过本地零点应归零')
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 最小间隔
// ══════════════════════════════════════════════════════════

test('护栏：未达最小间隔时拒绝并给出剩余等待时间', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.guard.recordSent({ sourceType: 'comment', atMs: BASE })

    const r = h.guard.canSend({ sourceType: 'comment', atMs: BASE + 30000 })
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.reason, 'interval_too_short')
    assert.strictEqual(r.detail.required_ms, 60000)
    assert.strictEqual(r.detail.wait_ms, 30000)

    assert.strictEqual(h.guard.canSend({ sourceType: 'comment', atMs: BASE + 61000 }).allow, true)
  } finally { h.cleanup() }
})

test('护栏：间隔按渠道独立（私信间隔更长）', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.guard.recordSent({ sourceType: 'dm', atMs: BASE })

    const at2min = BASE + 120000
    assert.strictEqual(h.guard.canSend({ sourceType: 'dm', atMs: at2min }).allow, false,
      '私信稳定期间隔 5 分钟')
    assert.strictEqual(h.guard.canSend({ sourceType: 'comment', atMs: at2min }).allow, true,
      '评论不受私信间隔影响')
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 活跃时段
// ══════════════════════════════════════════════════════════

test('护栏：活跃时段外拒绝发送', () => {
  const h = makeGuard({ nowMs: localTime(0, 3, 0) })
  try {
    h.guard.applyPolicy(stablePolicy())
    const r = h.guard.canSend({ sourceType: 'comment', atMs: localTime(0, 3, 0) })
    assert.strictEqual(r.allow, false)
    assert.strictEqual(r.reason, 'outside_active_hours')
    assert.strictEqual(h.guard.canSend({ sourceType: 'comment', atMs: BASE }).allow, true)
  } finally { h.cleanup() }
})

test('护栏：活跃时段边界（08:00 开始，23:00 结束）', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    const check = (hour, minute, expect, label) => {
      const r = h.guard.canSend({ sourceType: 'comment', atMs: localTime(0, hour, minute) })
      assert.strictEqual(r.allow, expect, `${label} 应${expect ? '放行' : '拒绝'}`)
    }
    check(7, 59, false, '07:59')
    check(8, 0, true, '08:00')
    check(22, 59, true, '22:59')
    check(23, 0, false, '23:00')
  } finally { h.cleanup() }
})

test('护栏：isWithinActiveHours 独立单测', () => {
  const hours = { tz_offset_minutes: 480, windows: [['08:00', '23:00']] }
  assert.strictEqual(G.isWithinActiveHours(localTime(0, 12, 0), hours), true)
  assert.strictEqual(G.isWithinActiveHours(localTime(0, 7, 0), hours), false)
  assert.strictEqual(G.isWithinActiveHours(localTime(0, 23, 30), hours), false)
  assert.strictEqual(G.isWithinActiveHours(localTime(0, 3, 0), { windows: [] }), true, '未配置=不限')
  assert.strictEqual(G.isWithinActiveHours(localTime(0, 3, 0), null), true)
})

// ══════════════════════════════════════════════════════════
// 急停
// ══════════════════════════════════════════════════════════

test('护栏：急停后立即拒绝所有渠道', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    assert.strictEqual(h.guard.canSend({ sourceType: 'comment', atMs: BASE }).allow, true)

    h.guard.setEmergencyStop(true, '商家手动急停')
    for (const s of ['comment', 'live_danmaku', 'dm']) {
      const r = h.guard.canSend({ sourceType: s, atMs: BASE })
      assert.strictEqual(r.allow, false, `急停后 ${s} 应被拒`)
      assert.strictEqual(r.reason, 'emergency_stop')
    }

    h.guard.setEmergencyStop(false)
    assert.strictEqual(h.guard.canSend({ sourceType: 'comment', atMs: BASE }).allow, true)
  } finally { h.cleanup() }
})

test('护栏：急停状态落盘（重启后仍生效）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-guard-es-'))
  try {
    const s1 = new Store({ dir })
    const g1 = new G.Guard({ store: s1, now: () => BASE })
    g1.applyPolicy(stablePolicy())
    g1.setEmergencyStop(true, '测试')
    s1.close()

    const s2 = new Store({ dir })
    try {
      const g2 = new G.Guard({ store: s2, now: () => BASE })
      assert.strictEqual(g2.emergencyStop, true, '急停必须跨重启保持')
    } finally { s2.close() }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

// ══════════════════════════════════════════════════════════
// 熔断（递进式）
// ══════════════════════════════════════════════════════════

test('护栏：每次风控触发上升一级（l1 → l2 → l3）', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())

    // ⚠️ 语义：**触发**上升一级，**到期**下降一级（对称，行为可预期）。
    //    因此连续触发（中间不衰减）应当逐级上升。
    const r1 = h.guard.recordResult({ ok: false, reason: 'risk_control_rejected' })
    assert.strictEqual(r1.level, 'l1')
    assert.strictEqual(r1.cooldown_ms, 1800000, 'L1 = 30 分钟')
    assert.match(r1.hint, /30 分钟/)
    assert.strictEqual(h.guard.canSend({ sourceType: 'comment', atMs: h.at() }).reason, 'circuit_open')

    const r2 = h.guard.recordResult({ ok: false, reason: 'risk_control_rejected' })
    assert.strictEqual(r2.level, 'l2')
    assert.strictEqual(r2.cooldown_ms, 3600000, 'L2 = 1 小时')
    assert.match(r2.hint, /1 小时/)

    const r3 = h.guard.recordResult({ ok: false, reason: 'risk_control_rejected' })
    assert.strictEqual(r3.level, 'l3')
    assert.match(r3.hint, /明天|次日/)
    assert.ok(r3.cooldown_ms > 0)

    // 已到最高级，继续触发不越界
    const r4 = h.guard.recordResult({ ok: false, reason: 'risk_control_rejected' })
    assert.strictEqual(r4.level, 'l3', 'L3 是最高级，不得越界')
  } finally { h.cleanup() }
})

test('护栏：到期后逐级下降（l3 → l2 → l1 → none）', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    // 推到 L3
    h.guard.recordResult({ ok: false, reason: 'risk_control_rejected' })
    h.guard.recordResult({ ok: false, reason: 'risk_control_rejected' })
    h.guard.recordResult({ ok: false, reason: 'risk_control_rejected' })
    assert.strictEqual(h.guard.circuit.level, 'l3')

    // 到期 → 降一级
    h.setTime(h.guard.circuit.untilMs + 1)
    assert.strictEqual(h.guard.decayCircuit(), true)
    assert.strictEqual(h.guard.circuit.level, 'l2', 'l3 到期应降到 l2')

    h.setTime(h.guard.circuit.untilMs + 1)
    h.guard.decayCircuit()
    assert.strictEqual(h.guard.circuit.level, 'l1', 'l2 到期应降到 l1')

    h.setTime(h.guard.circuit.untilMs + 1)
    h.guard.decayCircuit()
    assert.strictEqual(h.guard.circuit.level, 'none', 'l1 到期应完全解除')

    // 已解除后不再降级
    assert.strictEqual(h.guard.decayCircuit(), false)
  } finally { h.cleanup() }
})

test('护栏：未到期时 decayCircuit 不生效', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.guard.recordResult({ ok: false, reason: 'risk_control_rejected' })
    assert.strictEqual(h.guard.decayCircuit(), false, '未到期不得降级')
    assert.strictEqual(h.guard.circuit.level, 'l1')
  } finally { h.cleanup() }
})

test('护栏：isCircuitOpen 是纯查询，不产生副作用', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.guard.recordResult({ ok: false, reason: 'risk_control_rejected' })
    const levelBefore = h.guard.circuit.level

    for (let i = 0; i < 5; i++) h.guard.isCircuitOpen()
    assert.strictEqual(h.guard.circuit.level, levelBefore, '查询不得改变级别')

    h.setTime(h.at() + 1800001)
    // 到期后查询同样不得自行降级（必须显式 decayCircuit）
    for (let i = 0; i < 3; i++) h.guard.isCircuitOpen()
    assert.strictEqual(h.guard.circuit.level, levelBefore, '到期后查询同样不得降级')
  } finally { h.cleanup() }
})

test('护栏：普通失败累计达阈值也触发熔断', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy()) // platform_reject_threshold = 3
    assert.strictEqual(h.guard.recordResult({ ok: false, reason: 'element_timeout' }).escalated, undefined)
    assert.strictEqual(h.guard.recordResult({ ok: false, reason: 'element_timeout' }).escalated, undefined)
    assert.strictEqual(h.guard.recordResult({ ok: false, reason: 'element_timeout' }).escalated, true,
      '连续 3 次失败应熔断')
  } finally { h.cleanup() }
})

test('护栏：成功后清零连续失败计数', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.guard.recordResult({ ok: false, reason: 'element_timeout' })
    h.guard.recordResult({ ok: false, reason: 'element_timeout' })
    h.guard.recordResult({ ok: true })
    assert.strictEqual(h.guard.circuit.consecutiveFailures, 0)
    h.guard.recordResult({ ok: false, reason: 'element_timeout' })
    assert.strictEqual(h.guard.recordResult({ ok: false, reason: 'element_timeout' }).escalated, undefined)
  } finally { h.cleanup() }
})

test('护栏：手动清除熔断', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.guard.recordResult({ ok: false, reason: 'risk_control_rejected' })
    assert.strictEqual(h.guard.canSend({ sourceType: 'comment', atMs: h.at() }).reason, 'circuit_open')

    h.guard.clearCircuit()
    assert.strictEqual(h.guard.canSend({ sourceType: 'comment', atMs: h.at() }).allow, true)
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 持久化
// ══════════════════════════════════════════════════════════

test('护栏：日上限与熔断状态落盘，重启后仍生效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-guard-p-'))
  try {
    const s1 = new Store({ dir })
    const g1 = new G.Guard({ store: s1, now: () => BASE })
    g1.applyPolicy(stablePolicy())
    g1.setOverride('comment', 'daily_max', 2)
    g1.recordSent({ sourceType: 'comment', atMs: BASE })
    g1.recordSent({ sourceType: 'comment', atMs: BASE + 61000 })
    g1.recordResult({ ok: false, reason: 'risk_control_rejected' })
    s1.close()

    // 模拟进程重启
    const s2 = new Store({ dir })
    try {
      const g2 = new G.Guard({ store: s2, now: () => BASE + 122000 })
      assert.strictEqual(g2.usedToday('comment', BASE + 122000), 2, '日用量应已恢复')
      assert.strictEqual(g2.circuit.level, 'l1', '熔断状态应已恢复')

      g2.applyPolicy(stablePolicy())
      // ⚠️ 重启后熔断必须仍生效——否则"重启即可绕过"护栏
      const r = g2.canSend({ sourceType: 'comment', atMs: BASE + 122000 })
      assert.strictEqual(r.allow, false)
      assert.strictEqual(r.reason, 'circuit_open')
    } finally { s2.close() }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

// ══════════════════════════════════════════════════════════
// 快照
// ══════════════════════════════════════════════════════════

test('护栏：snapshot 提供界面展示所需的全部字段', () => {
  const h = makeGuard()
  try {
    h.guard.applyPolicy(stablePolicy())
    h.guard.recordSent({ sourceType: 'comment', atMs: BASE })
    const s = h.guard.snapshot()
    assert.strictEqual(s.sending_enabled, true)
    assert.strictEqual(s.emergency_stop, false)
    assert.strictEqual(s.account_tier, 'stable')
    assert.strictEqual(s.policy_version, 9)
    assert.strictEqual(s.used.comment, 1)
    assert.strictEqual(s.limits.comment.daily_max, 30)
    assert.ok(s.circuit)
  } finally { h.cleanup() }
})
