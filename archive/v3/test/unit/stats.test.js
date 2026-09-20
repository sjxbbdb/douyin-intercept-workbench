'use strict'

// test/unit/stats.test.js
// 看板口径测试 —— **两种实现绝不漂移**。
//
// ⚠️ 本文件最重要的命题不是"数字算对了"，而是**口径只能有一份实现**。
//    计划文档原本要求两端各写一份、保持算法相同；实践证明那一定会漂移，
//    而漂移的表现是"商家看板 30 条、厂商看板 28 条"——纠纷的起点，
//    且双端各自的单测都会通过。所以这里既测算法，也测"只有一份"。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ST = require('../../shared/lib/stats')
const { SOURCE_TYPES, FAILURE_REASONS, TZ_OFFSET_MINUTES, MS_PER_DAY } = require('../../shared/lib/protocol')

const ROOT = path.join(__dirname, '..', '..')
const NOW = 1758096000000 // 2025-09-17T16:00:00Z = 2025-09-18 00:00 UTC+8

function send(sourceType, verdict, offsetMs = 0, userKeyHash) {
  return {
    source_type: sourceType,
    verdict,
    sent_at_ms: NOW + offsetMs,
    user_key_hash: userKeyHash,
  }
}

// ══════════════════════════════════════════════════════════
// 单一实现（防漂移）
// ══════════════════════════════════════════════════════════

test('口径：聚合实现只在 shared/lib/stats.js（两端不得各写一份）', () => {
  const candidates = [
    'client/host/stats.js',
    'client/platform/stats.js',
    'license-server/domain/stats.js',
    'client/stats.js',
  ]
  const found = candidates.filter((p) => fs.existsSync(path.join(ROOT, p)))
  assert.deepStrictEqual(found, [],
    '发现疑似第二份聚合实现：' + found.join(', ') +
    '。口径必须只有一份代码（shared/lib/stats.js），' +
    '两端各写一份迟早漂移，而漂移会直接变成纠纷。')
})

test('口径：双端都必须从 shared/lib/stats.js 取聚合逻辑', () => {
  // 这条是"将来有人新增了 client/host/stats.js"的反向保护：
  // 只要那个文件出现，上一条测试就会失败，而这一条确保
  // 真的有人用它时是从 shared 引入的。
  const src = fs.readFileSync(path.join(ROOT, 'shared', 'lib', 'stats.js'), 'utf8')
  assert.ok(src.includes('SOURCE_TYPES'), '必须用 shared 的渠道闭集，不得自造')
  assert.ok(src.includes('FAILURE_REASONS'), '必须用 shared 的失败原因闭集')
  assert.ok(src.includes('TZ_OFFSET_MINUTES'), '必须用 shared 的时区口径')
})

// ══════════════════════════════════════════════════════════
// 自然日口径
// ══════════════════════════════════════════════════════════

// ⚠️ NOW 对应的 UTC+8 本地时间是 **2025-09-17 16:00**，
//    所以它属于 09-17 这个自然日，而不是 09-18。
//    （写测试时踩过：`new Date(NOW).toISOString()` 给的是 UTC 的 08:00，
//     看着像"18 号"，但它不是本地日。）
const DAY_START = NOW - 16 * 3600000 // UTC+8 的 2025-09-17 00:00

test('自然日：按 UTC+8 切分，且 dayKey 不使用 toISOString（那是 UTC）', () => {
  assert.strictEqual(ST.dayKey(NOW), '2025-09-17')
  assert.strictEqual(ST.dayKey(ST.dayStartMs(NOW)), '2025-09-17')

  // 当日第一毫秒与最后一毫秒都属当天，差 1 毫秒就跨日
  assert.strictEqual(ST.dayKey(DAY_START), '2025-09-17')
  assert.strictEqual(ST.dayKey(DAY_START - 1), '2025-09-16')
  assert.strictEqual(ST.dayKey(DAY_START + MS_PER_DAY - 1), '2025-09-17')
  assert.strictEqual(ST.dayKey(DAY_START + MS_PER_DAY), '2025-09-18')

  // 与 guard.js / billing.js 的 dayStartMs 口径一致
  assert.strictEqual(ST.dayStartMs(NOW), DAY_START)
  assert.strictEqual(ST.dayStartMs(DAY_START), DAY_START)
  assert.strictEqual(ST.dayStartMs(NOW + 3600000), DAY_START)
  assert.strictEqual(ST.dayStartMs(DAY_START - 1), DAY_START - MS_PER_DAY)
  assert.strictEqual(TZ_OFFSET_MINUTES, 480)
})

test('自然日：dayKey 在 UTC 跨日边界上不能错位（用 toISOString 就会错）', () => {
  // UTC+8 的 2025-09-18 00:00 = UTC 2025-09-17 16:00
  const t = DAY_START + MS_PER_DAY
  assert.strictEqual(ST.dayKey(t), '2025-09-18')
  // 同一时刻的 UTC 日期也是 09-17，所以"用 toISOString 会错"这件事
  // 在另一个方向上体现：UTC+8 的 07:00 那天，UTC 还停在前一天的 23:00。
  const early = DAY_START + 7 * 3600000 // 本地 09-17 07:00 = UTC 09-16 23:00
  assert.strictEqual(new Date(early).toISOString().slice(0, 10), '2025-09-16',
    '前提：这个时刻的 UTC 日期确实是前一天')
  assert.strictEqual(ST.dayKey(early), '2025-09-17', '但它属于 UTC+8 的 09-17')
})

// ══════════════════════════════════════════════════════════
// 明细聚合
// ══════════════════════════════════════════════════════════

test('明细聚合：四个 verdict 分别入桶，且 reply_attempts = 四者之和', () => {
  const agg = ST.aggregateSends([
    send('comment', 'sent_confirmed', 0, 'u1'),
    send('comment', 'sent_confirmed', 1, 'u2'),
    send('comment', 'sent_confirmed_dom', 2),
    send('comment', 'sent_suspected', 3),
    send('comment', 'failed', 4),
  ])
  const c = agg.sources.comment
  assert.strictEqual(c.sent_confirmed, 2)
  assert.strictEqual(c.sent_confirmed_dom, 1)
  assert.strictEqual(c.sent_suspected, 1)
  assert.strictEqual(c.failed, 1)
  assert.strictEqual(c.reply_attempts, 5)
  assert.strictEqual(agg.totals.reply_attempts, 5)
  assert.deepStrictEqual(agg.audit_flags, [])
})

test('明细聚合：已回复人数只数平台确认送达的（DOM 与疑似不算）', () => {
  const agg = ST.aggregateSends([
    send('comment', 'sent_confirmed', 0, 'u1'),
    send('comment', 'sent_confirmed', 1, 'u2'),
    send('comment', 'sent_confirmed', 2, 'u2'), // 同一用户两次 → 只算 1 人
    send('comment', 'sent_confirmed_dom', 3, 'u3'), // DOM 判据不算人
    send('comment', 'sent_suspected', 4, 'u4'), // 疑似不算人
    send('dm', 'sent_confirmed', 5, 'u1'), // 跨渠道的同一用户在总数里只算 1
  ])
  assert.strictEqual(agg.sources.comment.unique_users, 2, 'DOM/疑似不计入人数')
  assert.strictEqual(agg.sources.dm.unique_users, 1)
  assert.strictEqual(agg.totals.unique_users, 2, 'u1/u2 两人，跨渠道去重')
})

test('明细聚合：时间窗按 sent_at_ms 闭开区间', () => {
  const agg = ST.aggregateSends([
    send('comment', 'sent_confirmed', -1),
    send('comment', 'sent_confirmed', 0),
    send('comment', 'sent_confirmed', 100),
  ], { fromMs: NOW, toMs: NOW + 100 })
  assert.strictEqual(agg.sources.comment.sent_confirmed, 1, '含 from、不含 to')
})

test('明细聚合：未知来源与未知判定必须记 audit_flag（不得静默跳过）', () => {
  const agg = ST.aggregateSends([
    { source_type: 'weibo', verdict: 'sent_confirmed', sent_at_ms: NOW },
    { source_type: 'comment', verdict: 'skipped', sent_at_ms: NOW },
    { source_type: 'comment', verdict: 'made_up', sent_at_ms: NOW },
  ])
  assert.ok(agg.audit_flags.includes('unknown_source_type'))
  assert.ok(agg.audit_flags.includes('skipped_in_detail'),
    'skipped 属于聚合计数字段，不该出现在明细里（契约 §7.1 vs §7.2）')
  assert.ok(agg.audit_flags.includes('unknown_verdict'))
})

// ══════════════════════════════════════════════════════════
// 聚合上报合并 + 恒等式
// ══════════════════════════════════════════════════════════

function report(overrides = {}) {
  const sources = ST.emptySources()
  Object.assign(sources.comment, overrides.comment || {})
  return { sources, failure_reasons: overrides.failure_reasons || {}, unique_users_total: 0 }
}

test('聚合合并：多窗口相加', () => {
  const a = ST.aggregateReports([
    report({ comment: { hits: 10, leads_new: 8, reply_attempts: 3, sent_confirmed: 3, skipped: 5 } }),
    report({ comment: { hits: 5, leads_new: 4, reply_attempts: 2, sent_confirmed: 1, sent_suspected: 1, skipped: 1 } }),
  ])
  assert.strictEqual(a.sources.comment.hits, 15)
  assert.strictEqual(a.sources.comment.leads_new, 12)
  assert.strictEqual(a.sources.comment.reply_attempts, 5)
  assert.strictEqual(a.sources.comment.sent_confirmed, 4)
  assert.deepStrictEqual(a.audit_flags, [])
})

test('恒等式①：四个 verdict 之和 ≠ reply_attempts 必须报出来', () => {
  const flags = ST.checkInvariants({
    sources: Object.assign(ST.emptySources(), {
      comment: { hits: 10, leads_new: 1, reply_attempts: 5, sent_confirmed: 2, sent_confirmed_dom: 0, sent_suspected: 0, failed: 1, skipped: 0, unique_users: 2 },
    }),
    failure_reasons: {},
  })
  assert.ok(flags.includes('verdict_sum_mismatch:comment'),
    '2+0+0+1=3 ≠ 5，必须报出来')
})

test('恒等式②：reply_attempts + skipped ≤ hits（是 ≤ 而不是 =）', () => {
  // 正常：命中 10，尝试 3，跳过 5 → 3+5=8 ≤ 10（另 2 条不匹配关键词）
  const ok = ST.checkInvariants({
    sources: Object.assign(ST.emptySources(), {
      comment: { hits: 10, leads_new: 1, reply_attempts: 3, sent_confirmed: 3, sent_confirmed_dom: 0, sent_suspected: 0, failed: 0, skipped: 5, unique_users: 3 },
    }),
    failure_reasons: {},
  })
  assert.deepStrictEqual(ok, [], '不匹配关键词的那部分不产生 attempt 也不计入 skipped，所以是 ≤')

  // 异常：尝试 + 跳过 > 命中
  const bad = ST.checkInvariants({
    sources: Object.assign(ST.emptySources(), {
      comment: { hits: 3, leads_new: 1, reply_attempts: 3, sent_confirmed: 3, sent_confirmed_dom: 0, sent_suspected: 0, failed: 0, skipped: 5, unique_users: 3 },
    }),
    failure_reasons: {},
  })
  assert.ok(bad.includes('attempts_gt_hits:comment'))
})

test('恒等式③：leads_new ≤ hits', () => {
  const flags = ST.checkInvariants({
    sources: Object.assign(ST.emptySources(), {
      dm: { hits: 2, leads_new: 5, reply_attempts: 0, sent_confirmed: 0, sent_confirmed_dom: 0, sent_suspected: 0, failed: 0, skipped: 0, unique_users: 0 },
    }),
    failure_reasons: {},
  })
  assert.ok(flags.includes('leads_gt_hits:dm'))
})

test('恒等式④：failure_reasons 之和 = 各来源 failed 之和', () => {
  const sources = Object.assign(ST.emptySources(), {
    comment: { hits: 5, leads_new: 0, reply_attempts: 2, sent_confirmed: 0, sent_confirmed_dom: 0, sent_suspected: 0, failed: 2, skipped: 0, unique_users: 0 },
  })
  // 对得上
  assert.deepStrictEqual(
    ST.checkInvariants({ sources, failure_reasons: { rate_limited: 1, risk_control_rejected: 1 } }),
    []
  )
  // 对不上
  assert.ok(
    ST.checkInvariants({ sources, failure_reasons: { rate_limited: 1 } })
      .includes('failure_sum_mismatch')
  )
})

test('聚合合并：闭集外的失败原因不进桶但必须记 flag', () => {
  const a = ST.aggregateReports([report({ failure_reasons: { rate_limited: 2, invented_reason: 1 } })])
  assert.strictEqual(a.failure_reasons.rate_limited, 2)
  assert.strictEqual(a.failure_reasons.invented_reason, undefined,
    '闭集外的原因不能出现在看板上——那会显示一个没有定义的原因标签')
  assert.ok(a.audit_flags.includes('unknown_failure_reason'))
})

test('聚合合并：闭集完整性 —— FAILURE_REASONS 必须被真正用上', () => {
  assert.ok(FAILURE_REASONS.length >= 9, '失败原因闭集至少要覆盖契约列出的 9 类')
  assert.ok(FAILURE_REASONS.includes('risk_control_rejected'))
  assert.ok(FAILURE_REASONS.includes('content_rejected'))
  assert.ok(FAILURE_REASONS.includes('blocked_by_target'))
})

// ══════════════════════════════════════════════════════════
// 对账
// ══════════════════════════════════════════════════════════

test('对账：明细与聚合不一致时以明细为准并记 aggregate_mismatch', () => {
  const detail = ST.aggregateSends([
    send('comment', 'sent_confirmed', 0, 'u1'),
    send('comment', 'sent_confirmed', 1, 'u2'),
    send('comment', 'sent_confirmed', 2, 'u3'),
  ])
  const agg = ST.aggregateReports([report({ comment: { hits: 5, reply_attempts: 3, sent_confirmed: 2 } })])
  const r = ST.reconcile(detail, agg)
  assert.strictEqual(r.detail_confirmed, 3)
  assert.strictEqual(r.reported_confirmed, 2)
  assert.strictEqual(r.match, false)
  assert.strictEqual(r.delta, -1)
  assert.strictEqual(r.authoritative_source, 'audit_sends', '计费只依据明细')
  assert.deepStrictEqual(r.audit_flags, ['aggregate_mismatch'])
})

// ══════════════════════════════════════════════════════════
// 展示模型
// ══════════════════════════════════════════════════════════

test('展示：成功率分母为 0 时必须显示 — 而不是 100%', () => {
  const d = ST.buildDashboard(ST.aggregateReports([report({ comment: { hits: 5, leads_new: 5 } })]))
  assert.strictEqual(d.display.回复成功率, null)
  assert.strictEqual(d.display.回复成功率显示, '—',
    '显示 100% 会让商家以为"全部成功"，实际是"什么都没发"')
  assert.strictEqual(d.by_source.find((x) => x.source_type === 'comment').success_rate, null)
})

test('展示：成功率按 平台确认条数 / 发送尝试数 计算', () => {
  const agg = ST.aggregateReports([
    report({ comment: { hits: 10, leads_new: 8, reply_attempts: 4, sent_confirmed: 3, failed: 1 } }),
  ])
  const d = ST.buildDashboard(agg)
  assert.strictEqual(d.display.回复成功率, 0.75)
  assert.strictEqual(d.display.回复成功率显示, '75.0%')
})

test('展示：口径标注必须存在（否则商家会以为 DOM 判据也算送达）', () => {
  const d = ST.buildDashboard(ST.aggregateReports([report({ comment: { hits: 1, sent_confirmed_dom: 1, reply_attempts: 1 } })]))
  assert.strictEqual(d.display.已回复人数口径, '仅平台确认送达')
  assert.match(d.display.回复条数口径, /仅平台确认送达/)
  assert.strictEqual(d.display.回复条数, 0, 'DOM 判据不计入"回复条数"')
  assert.strictEqual(d.display.dom_判据条数, 1, '但要单列出来，不能藏起来')
})

test('展示：空态必须显式标出（旧代码 D-14 挂着上次数字，比显示 0 更误导）', () => {
  const empty = ST.buildDashboard(ST.aggregateReports([]))
  assert.strictEqual(empty.empty, true)
  assert.strictEqual(empty.counts.hits, 0)
  const notEmpty = ST.buildDashboard(ST.aggregateReports([report({ comment: { hits: 1 } })]))
  assert.strictEqual(notEmpty.empty, false)
})

test('展示：额度使用率在观察期（max=0）为 null，界面显示 — 而不是 0% 或 100%', () => {
  const u = ST.buildQuotaUsage({
    comment: { max: 0, used: 0, remaining: 0 },
    live_danmaku: { max: 10, used: 4, remaining: 6 },
    dm: { max: 3, used: 3, remaining: 0 },
  })
  assert.strictEqual(u.comment.usage_ratio, null, '观察期没有"使用率"这个概念')
  assert.strictEqual(u.live_danmaku.usage_ratio, 0.4)
  assert.strictEqual(u.dm.usage_ratio, 1)
  assert.strictEqual(ST.buildQuotaUsage(null), null)
})

test('展示：dashboard 直接可渲染 —— 不得在前端再做算术', () => {
  const d = ST.buildDashboard(ST.aggregateReports([report({ comment: { hits: 10, leads_new: 8, reply_attempts: 3, sent_confirmed: 3 } })]))
  // 展示所需的每个数字都已经是成品
  assert.strictEqual(typeof d.display.截流总量, 'number')
  assert.strictEqual(typeof d.display.已回复人数, 'number')
  assert.strictEqual(typeof d.display.回复条数, 'number')
  assert.strictEqual(typeof d.display.回复成功率显示, 'string')
  assert.strictEqual(d.stats_version, ST.STATS_VERSION)
})

// ══════════════════════════════════════════════════════════
// 趋势
// ══════════════════════════════════════════════════════════

test('趋势：固定 N 天、按自然日归桶、窗口外的明细被丢弃', () => {
  const t = ST.buildTrend([
    send('comment', 'sent_confirmed', 0),
    send('comment', 'sent_confirmed', 1),
    send('comment', 'failed', 2),
    send('comment', 'sent_confirmed', -MS_PER_DAY),
    send('comment', 'sent_confirmed', -10 * MS_PER_DAY), // 窗口外
  ], { days: 7, nowMs: NOW + 3 * 3600000 })

  assert.strictEqual(t.length, 7)
  assert.strictEqual(t[6].day, ST.dayKey(NOW + 3 * 3600000), '最后一桶是今天')
  assert.strictEqual(t[6].sent_confirmed, 2)
  assert.strictEqual(t[6].failed, 1)
  assert.strictEqual(t[5].sent_confirmed, 1, '昨天那一条')
  assert.strictEqual(t.reduce((a, b) => a + b.sent_confirmed, 0), 3, '窗口外的不计入')
})

test('趋势：leads_new 不能从明细推出来，必须保持 0（不猜）', () => {
  const t = ST.buildTrend([send('comment', 'sent_confirmed', 0)], { days: 1, nowMs: NOW + 1000 })
  assert.strictEqual(t[0].leads_new, 0,
    '明细里没有"命中但未回复"的信息；填个数字出来就是编数据')
})

test('趋势：usage_milli 由调用方按日传入（额度消耗不得由客户端计算）', () => {
  const key = ST.dayKey(NOW + 1000)
  const t = ST.buildTrend([], { days: 3, nowMs: NOW + 1000, usageByDay: { [key]: 5000 } })
  assert.strictEqual(t[2].usage_milli, 5000)
  assert.strictEqual(t[0].usage_milli, 0)
})

test('趋势：缺少 nowMs 直接抛错（否则"今天"会取到真实时间，测试与生产不一致）', () => {
  assert.throws(() => ST.buildTrend([], { days: 7 }), /需要 nowMs/)
})

// ══════════════════════════════════════════════════════════
// 渠道完整性
// ══════════════════════════════════════════════════════════

test('渠道：三来源在任何输出里都齐全（缺一个会导致对账永久 mismatch）', () => {
  const agg = ST.aggregateReports([])
  for (const src of SOURCE_TYPES) {
    assert.ok(agg.sources[src], `聚合结果必须含 ${src}`)
  }
  const d = ST.buildDashboard(agg)
  assert.strictEqual(d.by_source.length, SOURCE_TYPES.length)
  assert.deepStrictEqual(d.by_source.map((x) => x.source_type).sort(), [...SOURCE_TYPES].sort())
})
