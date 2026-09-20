'use strict'

// test/unit/policy.test.js
// 策略引擎测试 —— 红线 1 的守卫。
//
// ⚠️ 本文件是项目里最重要的测试之一。策略引擎出错意味着：
//   · 限额被放宽 → 商家账号被封
//   · "只能更保守"校验失效 → 客户端绕过护栏
//   · 等级推导错误 → 观察期被跳过（封号第一诱因）

const test = require('node:test')
const assert = require('node:assert')

const P = require('../../license-server/domain/policy')
const { SOURCE_TYPES } = require('../../shared/lib/protocol')

const NOW = 1758096000000 // 固定时间，避免测试随时间漂移

// ══════════════════════════════════════════════════════════
// 等级表本身
// ══════════════════════════════════════════════════════════

test('等级表：四级且天数边界连续无空隙', () => {
  assert.strictEqual(P.TIER_TABLE.length, 4)
  assert.deepStrictEqual(P.TIER_TABLE.map((t) => t.tier), ['observation', 'warm_up', 'ramp_up', 'stable'])
  assert.strictEqual(P.TIER_TABLE[0].day_from, 1)
  assert.strictEqual(P.TIER_TABLE[3].day_to, null, 'stable 无上限')
  for (let i = 1; i < P.TIER_TABLE.length; i++) {
    assert.strictEqual(P.TIER_TABLE[i].day_from, P.TIER_TABLE[i - 1].day_to + 1,
      `${P.TIER_TABLE[i].tier} 与前一级不连续`)
  }
})

test('等级表：观察期上限为 0 且禁发（新号满速是封号第一诱因）', () => {
  const obs = P.TIER_TABLE[0]
  assert.strictEqual(obs.sending_enabled, false)
  assert.strictEqual(obs.collect_only, true)
  for (const s of SOURCE_TYPES) {
    assert.strictEqual(obs.limits[s].daily_max, 0, `观察期 ${s} 上限必须为 0`)
  }
})

test('等级表：私信上限不高于评论（平台对陌生人私信管控更严）', () => {
  // ⚠️ 观察期两者都是 0（都不允许发送），故用 <= 而非 <
  for (const t of P.TIER_TABLE) {
    assert.ok(t.limits.dm.daily_max <= t.limits.comment.daily_max,
      `${t.tier} 的私信上限不应高于评论`)
  }
  // 可发送的等级上，私信必须严格更低
  for (const t of P.TIER_TABLE.filter((x) => x.sending_enabled)) {
    assert.ok(t.limits.dm.daily_max < t.limits.comment.daily_max,
      `${t.tier} 的私信上限应严格低于评论`)
  }
})

test('等级表：各渠道最小间隔落在允许区间内', () => {
  for (const t of P.TIER_TABLE) {
    for (const s of SOURCE_TYPES) {
      const v = t.limits[s].min_interval_ms
      const [lo, hi] = P.MIN_INTERVAL_MS_RANGE[s]
      assert.ok(v >= lo && v <= hi, `${t.tier}.${s} 间隔 ${v} 超出区间 [${lo},${hi}]`)
    }
  }
})

test('等级表：稳定期数值与需求规格 FR-2.3.1 一致（30/30/10）', () => {
  const stable = P.TIER_TABLE[3]
  assert.strictEqual(stable.limits.comment.daily_max, 30)
  assert.strictEqual(stable.limits.live_danmaku.daily_max, 30)
  assert.strictEqual(stable.limits.dm.daily_max, 10)
})

test('日上限合计：0 / 23 / 58 / 70', () => {
  assert.deepStrictEqual(
    P.TIER_TABLE.map((t) => SOURCE_TYPES.reduce((s, k) => s + t.limits[k].daily_max, 0)),
    [0, 23, 58, 70]
  )
  assert.strictEqual(P.stableDailyMaxTotal(), 70)
})

test('相似度语义写明方向（超过即拒绝），避免客户端实现弄反', () => {
  assert.match(P.CONTENT_SIMILARITY_SEMANTICS, /超过/)
  assert.match(P.CONTENT_SIMILARITY_SEMANTICS, /拒绝/)
})

// ══════════════════════════════════════════════════════════
// 等级推导
// ══════════════════════════════════════════════════════════

test('等级推导：第 1 天为 1，随后逐日递增', () => {
  const first = NOW
  assert.strictEqual(P.deriveDayIndex(first, first), 1)
  assert.strictEqual(P.deriveDayIndex(first, first + 86400000), 2)
  assert.strictEqual(P.deriveDayIndex(first, first + 3 * 86400000), 4)
})

test('等级推导：按自然日而非 24 小时窗（商家理解的是日历日）', () => {
  // 首次登录 00:00(UTC+8)
  const first = Date.UTC(2026, 8, 18, 0, 0, 0) - 8 * 3600 * 1000
  // 当天 23:00 仍是第 1 天
  const sameDayLate = first + 23 * 3600 * 1000
  assert.strictEqual(P.deriveDayIndex(first, sameDayLate), 1, '同一自然日应为第 1 天')
  // 次日 00:30 是第 2 天
  const nextDayEarly = first + 24 * 3600 * 1000 + 30 * 60 * 1000
  assert.strictEqual(P.deriveDayIndex(first, nextDayEarly), 2)
})

test('等级推导：无效首次登录时间按第 1 天处理', () => {
  assert.strictEqual(P.deriveDayIndex(0, NOW), 1)
  assert.strictEqual(P.deriveDayIndex(null, NOW), 1)
  assert.strictEqual(P.deriveDayIndex(undefined, NOW), 1)
  assert.strictEqual(P.deriveDayIndex(-1, NOW), 1)
})

test('等级推导：天数不会小于 1（时钟回拨防护）', () => {
  assert.strictEqual(P.deriveDayIndex(NOW, NOW - 10 * 86400000), 1)
})

test('等级映射：边界值 1/3/4/7/8/14/15/100', () => {
  const cases = [
    [1, 'observation'], [2, 'observation'], [3, 'observation'],
    [4, 'warm_up'], [5, 'warm_up'], [7, 'warm_up'],
    [8, 'ramp_up'], [10, 'ramp_up'], [14, 'ramp_up'],
    [15, 'stable'], [30, 'stable'], [100, 'stable'], [9999, 'stable'],
  ]
  for (const [day, expect] of cases) {
    assert.strictEqual(P.tierForDayIndex(day).tier, expect, `第 ${day} 天应为 ${expect}`)
  }
})

test('等级映射：0 或负数按第 1 天处理', () => {
  assert.strictEqual(P.tierForDayIndex(0).tier, 'observation')
  assert.strictEqual(P.tierForDayIndex(-5).tier, 'observation')
})

test('距下一档：边界与最高档', () => {
  assert.strictEqual(P.daysUntilNextTier(1), 3, '第1天距升到预热期还有3天')
  assert.strictEqual(P.daysUntilNextTier(3), 1)
  assert.strictEqual(P.daysUntilNextTier(4), 4)
  assert.strictEqual(P.daysUntilNextTier(14), 1)
  assert.strictEqual(P.daysUntilNextTier(15), null, '稳定期无下一档')
})

test('下一档名称', () => {
  assert.strictEqual(P.nextTierName(1), 'warm_up')
  assert.strictEqual(P.nextTierName(5), 'ramp_up')
  assert.strictEqual(P.nextTierName(10), 'stable')
  assert.strictEqual(P.nextTierName(20), null)
})

// ══════════════════════════════════════════════════════════
// 构造下发对象
// ══════════════════════════════════════════════════════════

test('buildPolicy：观察期下发禁发语义', () => {
  const p = P.buildPolicy({ accountId: 1, accountDayIndex: 2, policyVersion: 7, nowMs: NOW })
  assert.strictEqual(p.account_tier, 'observation')
  assert.strictEqual(p.sending_enabled, false)
  assert.strictEqual(p.collect_only, true)
  assert.strictEqual(p.limits.comment.daily_max, 0)
  assert.strictEqual(p.account_day_index, 2)
  assert.strictEqual(p.next_tier, 'warm_up')
  assert.strictEqual(p.days_until_next_tier, 2)
})

test('buildPolicy：含 policy_hash，且同输入同哈希（ack 存证依赖它）', () => {
  const a = P.buildPolicy({ accountId: 1, accountDayIndex: 5, policyVersion: 7, nowMs: NOW })
  const b = P.buildPolicy({ accountId: 1, accountDayIndex: 5, policyVersion: 7, nowMs: NOW + 999 })
  assert.match(a.policy_hash, /^[0-9a-f]{16}$/)
  assert.strictEqual(a.policy_hash, b.policy_hash, 'policy_hash 不应随生成时间变化')
})

test('buildPolicy：等级或版本变化时 policy_hash 变化', () => {
  const a = P.buildPolicy({ accountId: 1, accountDayIndex: 5, policyVersion: 7, nowMs: NOW })
  const b = P.buildPolicy({ accountId: 1, accountDayIndex: 10, policyVersion: 7, nowMs: NOW })
  const c = P.buildPolicy({ accountId: 1, accountDayIndex: 5, policyVersion: 8, nowMs: NOW })
  assert.notStrictEqual(a.policy_hash, b.policy_hash, '等级变化应改变哈希')
  assert.notStrictEqual(a.policy_hash, c.policy_hash, '策略版本变化应改变哈希')
})

test('buildPolicy：含活跃时段单窗口与区间约束', () => {
  const p = P.buildPolicy({ accountId: 1, accountDayIndex: 20, policyVersion: 9, nowMs: NOW })
  assert.deepStrictEqual(p.active_hours.windows, [['08:00', '23:00']], '默认为单一窗口')
  assert.strictEqual(p.active_hours.tz_offset_minutes, 480)
  assert.ok(p.min_interval_ms_range.comment)
})

test('buildPolicy：熔断为三级递进（30分钟 → 1小时 → 停到次日）', () => {
  const p = P.buildPolicy({ accountId: 1, accountDayIndex: 20, policyVersion: 9, nowMs: NOW })
  assert.strictEqual(p.circuit_breaker.cooldown_ms, 1800000, 'L1 = 30 分钟')
  assert.strictEqual(p.circuit_breaker.cooldown_l2_ms, 3600000, 'L2 = 1 小时')
  assert.strictEqual(p.circuit_breaker.risk_code_cooldown_ms, 86400000, 'L3 = 停到次日')
})

test('tierTableForClient：合计与稳定期基数正确', () => {
  const t = P.tierTableForClient()
  assert.deepStrictEqual(t.daily_cap_total_by_tier, { observation: 0, warm_up: 23, ramp_up: 58, stable: 70 })
  assert.strictEqual(t.stable_daily_max_total, 70)
  assert.strictEqual(t.client_may_only_be_more_conservative, true)
})

// ══════════════════════════════════════════════════════════
// ⚠️ "只能更保守" 校验 —— 四个方向
// ══════════════════════════════════════════════════════════

const policy = P.buildPolicy({ accountId: 1, accountDayIndex: 20, policyVersion: 9, nowMs: NOW })

test('校验：更保守的配置全部通过', () => {
  assert.doesNotThrow(() => P.validateClientLimits({
    // ⚠️ 间隔必须在允许区间内（comment 上界 180000），
    //    "更长"不等于可以任意长——超上界会被拒（见下一条测试）
    comment: { daily_max: 10, min_interval_ms: 180000, content_similarity_max: 0.7 },
    dm: { daily_max: 3, min_interval_ms: 900000 },
  }, policy))
})

test('校验：完全不上报也通过（未配置即使用服务端值）', () => {
  assert.doesNotThrow(() => P.validateClientLimits(undefined, policy))
  assert.doesNotThrow(() => P.validateClientLimits(null, policy))
  assert.doesNotThrow(() => P.validateClientLimits({}, policy))
})

test('校验：daily_max 只能调低 —— 调高被拒', () => {
  assert.throws(
    () => P.validateClientLimits({ comment: { daily_max: 200 } }, policy),
    (e) => e.code === 'POLICY_VIOLATION' && e.detail.field === 'daily_max' && e.detail.allowed === 30
  )
  // 相等允许
  assert.doesNotThrow(() => P.validateClientLimits({ comment: { daily_max: 30 } }, policy))
  // 调低允许
  assert.doesNotThrow(() => P.validateClientLimits({ comment: { daily_max: 5 } }, policy))
})

test('校验：min_interval_ms 只能调高 —— 调低被拒', () => {
  assert.throws(
    () => P.validateClientLimits({ comment: { min_interval_ms: 1000 } }, policy),
    (e) => e.code === 'POLICY_VIOLATION' && e.detail.field === 'min_interval_ms'
  )
  // 调高允许
  assert.doesNotThrow(() => P.validateClientLimits({ comment: { min_interval_ms: 180000 } }, policy))
})

test('校验：min_interval_ms 不得超过允许区间上限（否则等于变相停发）', () => {
  assert.throws(
    () => P.validateClientLimits({ comment: { min_interval_ms: 99999999 } }, policy),
    (e) => e.code === 'POLICY_VIOLATION' && e.detail.field === 'min_interval_ms'
  )
})

test('校验：content_similarity_max 只能调低（方向最易弄反）', () => {
  // 调高 = 更宽松 = 拒绝
  assert.throws(
    () => P.validateClientLimits({ comment: { content_similarity_max: 0.99 } }, policy),
    (e) => e.code === 'POLICY_VIOLATION' && e.detail.field === 'content_similarity_max'
  )
  // 相等允许
  assert.doesNotThrow(() => P.validateClientLimits({ comment: { content_similarity_max: 0.85 } }, policy))
  // 调低 = 更严格 = 允许
  assert.doesNotThrow(() => P.validateClientLimits({ comment: { content_similarity_max: 0.6 } }, policy))
})

test('校验：三渠道分别校验（改 dm 不影响 comment）', () => {
  assert.throws(
    () => P.validateClientLimits({ dm: { daily_max: 50 } }, policy),
    (e) => e.detail.source_type === 'dm' && e.detail.allowed === 10
  )
})

test('校验：未知来源类型被拒', () => {
  assert.throws(
    () => P.validateClientLimits({ weibo: { daily_max: 1 } }, policy),
    (e) => e.code === 'POLICY_TIER_UNKNOWN'
  )
})

test('校验：active_hours 只能调短 —— 延长被拒', () => {
  assert.throws(
    () => P.validateClientLimits({ active_hours: { windows: [['06:00', '23:00']] } }, policy),
    (e) => e.code === 'POLICY_VIOLATION' && e.detail.field === 'active_hours'
  )
})

test('校验：active_hours 不得新增窗口', () => {
  assert.throws(
    () => P.validateClientLimits({
      active_hours: { windows: [['08:00', '12:00'], ['14:00', '18:00']] },
    }, policy),
    (e) => e.code === 'POLICY_VIOLATION'
  )
  assert.throws(
    () => P.validateClientLimits({
      active_hours: { windows: [['08:00', '23:00'], ['08:00', '09:00']] },
    }, policy),
    (e) => e.code === 'POLICY_VIOLATION'
  )
})

test('校验：active_hours 调短或相等通过；空窗口（完全不发）通过', () => {
  assert.doesNotThrow(() => P.validateClientLimits({
    active_hours: { windows: [['09:00', '12:00']] },
  }, policy))
  assert.doesNotThrow(() => P.validateClientLimits({
    active_hours: { windows: [['08:00', '23:00']] },
  }, policy))
  assert.doesNotThrow(() => P.validateClientLimits({ active_hours: { windows: [] } }, policy))
})

test('校验：active_hours 非法格式被拒', () => {
  assert.throws(() => P.validateClientLimits({ active_hours: { windows: [['25:00', '26:00']] } }, policy),
    (e) => e.code === 'POLICY_VIOLATION')
  assert.throws(() => P.validateClientLimits({ active_hours: { windows: [['abc', 'def']] } }, policy),
    (e) => e.code === 'POLICY_VIOLATION')
  assert.throws(() => P.validateClientLimits({ active_hours: { windows: [['18:00', '09:00']] } }, policy),
    (e) => e.code === 'POLICY_VIOLATION')
})

test('校验：观察期下任何上限 > 0 都被拒（不放行观察期发送）', () => {
  const obs = P.buildPolicy({ accountId: 1, accountDayIndex: 1, policyVersion: 7, nowMs: NOW })
  assert.throws(
    () => P.validateClientLimits({ comment: { daily_max: 1 } }, obs),
    (e) => e.code === 'POLICY_VIOLATION' && e.detail.allowed === 0
  )
})

test('isActiveHoursShorterOrEqual：独立单测', () => {
  const server = { windows: [['08:00', '23:00']] }
  assert.strictEqual(P.isActiveHoursShorterOrEqual({ windows: [['09:00', '20:00']] }, server), true)
  assert.strictEqual(P.isActiveHoursShorterOrEqual({ windows: [['08:00', '23:00']] }, server), true)
  assert.strictEqual(P.isActiveHoursShorterOrEqual({ windows: [['07:59', '23:00']] }, server), false)
  assert.strictEqual(P.isActiveHoursShorterOrEqual({ windows: [['08:00', '23:01']] }, server), false)
  assert.strictEqual(P.isActiveHoursShorterOrEqual({ windows: [] }, server), true)
  assert.strictEqual(P.isActiveHoursShorterOrEqual(null, server), false)
  assert.strictEqual(P.isActiveHoursShorterOrEqual({ windows: 'x' }, server), false)
})

// ══════════════════════════════════════════════════════════
// 套餐积分（必须由等级表推导）
// ══════════════════════════════════════════════════════════

test('套餐积分：半年 = 70×180 = 12600，年 = 70×365 = 25550', () => {
  assert.strictEqual(P.planCreditsFor(180), 12600)
  assert.strictEqual(P.planCreditsFor(365), 25550)
  assert.strictEqual(P.minPlanCredit(), 12600)
})

test('套餐积分：由等级表推导而非硬编码（改表即变）', () => {
  const total = P.stableDailyMaxTotal()
  assert.strictEqual(P.planCreditsFor(180), total * 180)
  // 若等级表变了，套餐积分必须跟着变——这里用公式验证依赖关系
  const stable = P.TIER_TABLE.find((t) => t.tier === 'stable')
  const manual = SOURCE_TYPES.reduce((s, k) => s + stable.limits[k].daily_max, 0) * 180
  assert.strictEqual(P.planCreditsFor(180), manual)
})

test('套餐积分：折扣系数生效', () => {
  assert.strictEqual(P.planCreditsFor(180, 0.5), 6300)
  assert.strictEqual(P.planCreditsFor(180, 2), 25200)
})
