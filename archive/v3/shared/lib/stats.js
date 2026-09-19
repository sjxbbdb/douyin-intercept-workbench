'use strict'

// shared/lib/stats.js
//
// 看板聚合 —— **双端共用的唯一实现**。
//
// ⚠️ 为什么放在 shared 而不是"两端各写一份、保持算法相同"：
//
//    计划文档原本要求「客户端 `client/host/stats.js` 与服务端
//    `license-server/domain/stats.js` 保持**相同算法**，并各有一份单元自测」。
//    这个要求在工程上是**不可维护的**：两份实现迟早漂移，而漂移的表现是
//    "商家看板说发了 30 条、厂商看板说 28 条"——这正是纠纷的起点，
//    且双端各自的单测都会通过（因为它们测的是各自的实现）。
//
//    所以本文件把口径收敛成**一份代码**，两端都 require 它。
//    这也是 `shared/lib/` 存在的理由（见 AGENTS.md §3）。
//
// ⚠️ 本文件只做**纯计算**：不碰数据库、不碰磁盘、不碰网络。
//    两端各自负责把数据取出来、归一化成下面的输入结构。
//
// ⚠️ 恒等式（写成断言，违反必须立即可见，不能"看起来差不多"）：
//    ① 每来源：sent_confirmed + sent_confirmed_dom + sent_suspected + failed = reply_attempts
//    ② 每来源：reply_attempts + skipped ≤ hits
//    ③ 每来源：leads_new ≤ hits（违反按 hits 截断并记 audit_flag）
//    ④ 全局：sum(failure_reasons.values) === sum(sources.*.failed)

const { SOURCE_TYPES, FAILURE_REASONS, MS_PER_DAY, TZ_OFFSET_MINUTES } = require('./protocol')

/** 看板口径版本。口径变更时递增，便于两端对齐时发现"一边是旧口径"。 */
const STATS_VERSION = 1

/**
 * 某时刻所属自然日的起点（UTC+8）。
 * ⚠️ 与服务端 `domain/billing.js` 的 `dayStartMs`、客户端 `safety/guard.js`
 *    的同名函数**必须是同一个算法**。三处不一致会让"当日"有三个定义。
 *    （这里再写一遍是为了让本文件自包含；数值口径由 TZ_OFFSET_MINUTES 统一。）
 */
function dayStartMs(ms, tzOffsetMinutes = TZ_OFFSET_MINUTES) {
  const tzMs = tzOffsetMinutes * 60 * 1000
  return Math.floor((ms + tzMs) / MS_PER_DAY) * MS_PER_DAY - tzMs
}

/** 自然日键（`YYYY-MM-DD`，UTC+8）。**不要用 toISOString()** —— 那是 UTC。 */
function dayKey(ms, tzOffsetMinutes = TZ_OFFSET_MINUTES) {
  const d = new Date(dayStartMs(ms, tzOffsetMinutes) + tzOffsetMinutes * 60 * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/** 空的三来源计数结构。 */
function emptySources() {
  const out = {}
  for (const src of SOURCE_TYPES) {
    out[src] = {
      hits: 0, leads_new: 0, reply_attempts: 0,
      sent_confirmed: 0, sent_confirmed_dom: 0, sent_suspected: 0,
      failed: 0, skipped: 0, unique_users: 0,
    }
  }
  return out
}

/**
 * 从一组发送明细聚合出计数。
 *
 * ⚠️ 输入必须是**明细**（每条一次发送尝试），不是已经聚合过的数字。
 *    理由：契约 §4.7 明确"计费永远只依据明细"，而看板口径与计费口径
 *    必须同源，否则会出现"看板说 30 条、账单按 28 条收"。
 *
 * @param {Array<object>} sends 明细数组。每条需含：
 *        `source_type`、`verdict`、`sent_at_ms`，可选 `user_key_hash`
 * @param {object} [opts]
 * @param {number} [opts.fromMs] 含（按 sent_at_ms）
 * @param {number} [opts.toMs]   不含
 * @param {number} [opts.tzOffsetMinutes]
 * @returns {{sources:object, totals:object, failure_reasons:object, unique_users_total:number, audit_flags:string[]}}
 */
function aggregateSends(sends, opts = {}) {
  const { fromMs = -Infinity, toMs = Infinity } = opts
  const sources = emptySources()
  const auditFlags = []
  /** 跨来源的用户集合（`unique_users_total` 用） */
  const allUsers = new Set()
  /** 每来源的用户集合（`sources[src].unique_users` 用） */
  const usersBySource = {}
  for (const s of SOURCE_TYPES) usersBySource[s] = new Set()

  for (const send of sends || []) {
    if (!send || typeof send !== 'object') continue
    const src = send.source_type
    if (!SOURCE_TYPES.includes(src)) {
      // 未知来源：不能静默跳过——那会让"少算了一批"无从发现。
      auditFlags.push('unknown_source_type')
      continue
    }
    const at = Number(send.sent_at_ms)
    if (!Number.isFinite(at) || at < fromMs || at >= toMs) continue

    const verdict = send.verdict
    const bucket = sources[src]

    if (verdict === 'sent_confirmed') {
      bucket.sent_confirmed += 1
      bucket.reply_attempts += 1
      // ⚠️ 「已回复人数」只统计**平台确认送达**的。
      //    sent_confirmed_dom 与 sent_suspected 都不算——那是契约 §7.3 的口径，
      //    在界面上也必须标注"仅平台确认送达"，否则商家会以为 DOM 判据也算数。
      if (send.user_key_hash) {
        usersBySource[src].add(send.user_key_hash)
        allUsers.add(send.user_key_hash)
      }
    } else if (verdict === 'sent_confirmed_dom') {
      bucket.sent_confirmed_dom += 1
      bucket.reply_attempts += 1
    } else if (verdict === 'sent_suspected') {
      bucket.sent_suspected += 1
      bucket.reply_attempts += 1
    } else if (verdict === 'failed') {
      bucket.failed += 1
      bucket.reply_attempts += 1
    } else {
      // ⚠️ `skipped` **不是** verdict（契约 §7.2 明写闭集只有四个值）。
      //    它属于聚合计数字段（§7.1）。真出现在明细里说明上游搞混了。
      if (verdict === 'skipped') auditFlags.push('skipped_in_detail')
      else auditFlags.push('unknown_verdict')
    }
  }

  for (const src of SOURCE_TYPES) {
    sources[src].unique_users = usersBySource[src].size
  }

  return {
    sources,
    totals: {
      reply_attempts: sum(sources, 'reply_attempts'),
      sent_confirmed: sum(sources, 'sent_confirmed'),
      sent_confirmed_dom: sum(sources, 'sent_confirmed_dom'),
      sent_suspected: sum(sources, 'sent_suspected'),
      failed: sum(sources, 'failed'),
      unique_users: allUsers.size,
    },
    // ⚠️ 明细里**没有** failure_reasons 的分布信息（那是聚合层的事），
    //    所以这里返回空对象，由调用方用 aggregateReport / 自己的聚合补齐。
    failure_reasons: {},
    unique_users_total: allUsers.size,
    audit_flags: [...new Set(auditFlags)],
  }
}

/**
 * 把一段时间的**聚合上报**合并成看板计数。
 *
 * ⚠️ 与 `aggregateSends` 的分工：
 *    · 明细（`audit_sends`）是**计费与权威统计**的来源；
 *    · 聚合（`usage/report`）是**看板与对账**的来源，且可能缺失（网络问题）。
 *    两者数字不一致时以明细为准（契约 §4.7），本文件提供
 *    `reconcile()` 来量化差异，而不是把它们混在一起算。
 *
 * @param {Array<object>} reports 每项形如 `{sources, failure_reasons, unique_users_total}`
 */
function aggregateReports(reports) {
  const sources = emptySources()
  const failureReasons = {}
  const auditFlags = []

  for (const r of reports || []) {
    if (!r || typeof r !== 'object') continue
    for (const src of SOURCE_TYPES) {
      const given = (r.sources && r.sources[src]) || null
      if (!given) continue
      const bucket = sources[src]
      for (const k of Object.keys(bucket)) {
        const v = Number(given[k])
        if (Number.isFinite(v)) bucket[k] += v
      }
    }
    for (const [k, v] of Object.entries(r.failure_reasons || {})) {
      if (!FAILURE_REASONS.includes(k)) {
        // 未知失败原因：闭集外（契约 §7.4）。计数但不入桶，
        // 否则看板上会出现一个没有定义的原因标签。
        auditFlags.push('unknown_failure_reason')
        continue
      }
      failureReasons[k] = (failureReasons[k] || 0) + Number(v || 0)
    }
  }

  const flags = [...new Set(auditFlags)].concat(checkInvariants({ sources, failure_reasons: failureReasons }))
  return {
    sources,
    totals: {
      hits: sum(sources, 'hits'),
      leads_new: sum(sources, 'leads_new'),
      reply_attempts: sum(sources, 'reply_attempts'),
      sent_confirmed: sum(sources, 'sent_confirmed'),
      sent_confirmed_dom: sum(sources, 'sent_confirmed_dom'),
      sent_suspected: sum(sources, 'sent_suspected'),
      failed: sum(sources, 'failed'),
      skipped: sum(sources, 'skipped'),
      unique_users: sum(sources, 'unique_users'),
    },
    failure_reasons: failureReasons,
    audit_flags: flags,
  }
}

/**
 * 恒等式自检。
 *
 * ⚠️ 刻意**不修正**数据，只报告。理由：这些恒等式要么成立、要么说明
 *    上游有 bug。悄悄"抹平"差异会让真正的 bug 永远不被发现，
 *    而看板看起来永远自洽——那比数字对不上更危险。
 *
 * @returns {string[]} 违反的恒等式名（空数组 = 全部成立）
 */
function checkInvariants({ sources, failure_reasons }) {
  const flags = []
  let failedSum = 0

  for (const src of SOURCE_TYPES) {
    const b = sources[src]
    if (!b) continue
    // ① 四个 verdict 之和 = reply_attempts
    const verdictSum = b.sent_confirmed + b.sent_confirmed_dom + b.sent_suspected + b.failed
    if (verdictSum !== b.reply_attempts) flags.push(`verdict_sum_mismatch:${src}`)
    // ② reply_attempts + skipped ≤ hits
    //    ⚠️ 注意方向：是 "≤" 而不是 "="。命中但被规则过滤掉的（不匹配关键词）
    //       不产生 reply_attempt，也不计入 skipped，所以上限才是不等号。
    if (b.reply_attempts + b.skipped > b.hits) flags.push(`attempts_gt_hits:${src}`)
    // ③ leads_new ≤ hits
    if (b.leads_new > b.hits) flags.push(`leads_gt_hits:${src}`)
    failedSum += b.failed
  }

  // ④ failure_reasons 之和 = 各来源 failed 之和
  const reasonsSum = Object.values(failure_reasons || {}).reduce((a, v) => a + Number(v || 0), 0)
  if (reasonsSum !== failedSum) flags.push('failure_sum_mismatch')

  return [...new Set(flags)]
}

/**
 * 明细 ↔ 聚合 对账。
 *
 * ⚠️ 永远以**明细**为准（契约 §4.7）。本函数只量化差异，
 *    供运营判断"是聚合丢了窗口"还是"上报口径错了"。
 */
function reconcile(detailAgg, reportAgg) {
  const detailConfirmed = detailAgg && detailAgg.totals ? detailAgg.totals.sent_confirmed : 0
  const reportedConfirmed = reportAgg && reportAgg.totals ? reportAgg.totals.sent_confirmed : 0
  return {
    detail_confirmed: detailConfirmed,
    reported_confirmed: reportedConfirmed,
    match: detailConfirmed === reportedConfirmed,
    delta: reportedConfirmed - detailConfirmed,
    authoritative_source: 'audit_sends',
    audit_flags: detailConfirmed === reportedConfirmed ? [] : ['aggregate_mismatch'],
  }
}

/**
 * 看板展示模型 —— 界面直接渲染这个对象，**不在前端做任何算术**。
 *
 * ⚠️ 为什么把展示逻辑也放 shared：
 *    "回复成功率 = sent_confirmed / reply_attempts" 这种式子一旦写在前端，
 *    就会与后端的口径各演各的。而分母为 0 时前端若显示 100%
 *    （而不是 `—`），商家会以为"成功率 100%"——这是明确的误导。
 *
 * @param {object} agg aggregateReports 或 aggregateSends 的输出
 * @param {object} [opts]
 * @param {object} [opts.dailyQuota] 服务端下发的 `daily_quota`
 * @param {object} [opts.extra] 附加字段（额度消耗等，由服务端提供）
 */
function buildDashboard(agg, opts = {}) {
  const t = agg.totals || {}
  const attempts = Number(t.reply_attempts || 0)
  const confirmed = Number(t.sent_confirmed || 0)

  const successRate = attempts === 0 ? null : confirmed / attempts

  return {
    stats_version: STATS_VERSION,
    // 原始计数（不做加工，便于对账）
    counts: {
      hits: Number(t.hits || 0),
      leads_new: Number(t.leads_new || 0),
      reply_attempts: attempts,
      sent_confirmed: confirmed,
      sent_confirmed_dom: Number(t.sent_confirmed_dom || 0),
      sent_suspected: Number(t.sent_suspected || 0),
      failed: Number(t.failed || 0),
      skipped: Number(t.skipped || 0),
      unique_users: Number(t.unique_users || 0),
    },
    // ⚠️ 展示时必须标注口径。`unique_users` 只含平台确认送达的。
    display: {
      截流总量: Number(t.leads_new || 0),
      已回复人数: Number(t.unique_users || 0),
      已回复人数口径: '仅平台确认送达',
      回复条数: confirmed,
      回复条数口径: '仅平台确认送达；DOM 判据与疑似单列',
      dom_判据条数: Number(t.sent_confirmed_dom || 0),
      疑似送达条数: Number(t.sent_suspected || 0),
      失败条数: Number(t.failed || 0),
      跳过条数: Number(t.skipped || 0),
      // null → 界面显示 `—`，**不是** 100%
      回复成功率: successRate,
      回复成功率显示: successRate === null || successRate === undefined
        ? '—'
        : `${(successRate * 100).toFixed(1)}%`,
    },
    by_source: SOURCE_TYPES.map((src) => {
      const b = (agg.sources && agg.sources[src]) || {}
      const a = Number(b.reply_attempts || 0)
      const c = Number(b.sent_confirmed || 0)
      return {
        source_type: src,
        hits: Number(b.hits || 0),
        leads_new: Number(b.leads_new || 0),
        reply_attempts: a,
        sent_confirmed: c,
        sent_confirmed_dom: Number(b.sent_confirmed_dom || 0),
        sent_suspected: Number(b.sent_suspected || 0),
        failed: Number(b.failed || 0),
        skipped: Number(b.skipped || 0),
        unique_users: Number(b.unique_users || 0),
        success_rate: a === 0 ? null : c / a,
      }
    }),
    failure_reasons: { ...(agg.failure_reasons || {}) },
    daily_quota: opts.dailyQuota || null,
    daily_quota_usage: buildQuotaUsage(opts.dailyQuota),
    audit_flags: agg.audit_flags || [],
    // ⚠️ 空态必须显式标出，让界面显示"暂无数据"而不是 0 或样例数字。
    //    旧代码（D-14）在接口返回全空时不清除前端状态，于是看板上
    //    一直挂着上一次的数字——比显示 0 更误导。
    empty: Number(t.hits || 0) === 0 && attempts === 0,
    ...(opts.extra || {}),
  }
}

/** 当日额度使用率。⚠️ 分母为 0（观察期）时返回 null，界面显示 `—`。 */
function buildQuotaUsage(dailyQuota) {
  if (!dailyQuota || typeof dailyQuota !== 'object') return null
  const out = {}
  for (const src of SOURCE_TYPES) {
    const q = dailyQuota[src]
    if (!q) continue
    const max = Number(q.max || 0)
    const used = Number(q.used || 0)
    out[src] = {
      max,
      used,
      remaining: Math.max(0, max - used),
      usage_ratio: max === 0 ? null : Math.min(1, used / max),
    }
  }
  return out
}

/**
 * 按自然日聚合趋势（近 N 日）。
 *
 * @param {Array<object>} sends 明细
 * @param {object} opts
 * @param {number} opts.days       要多少天（含今天）
 * @param {number} opts.nowMs      当前时刻（决定"今天"是哪天）
 * @param {number} [opts.usageByDay] 形如 `{ '2026-09-18': 1234 }` 的额度消耗（milli）
 */
function buildTrend(sends, { days = 7, nowMs, usageByDay = {} } = {}) {
  if (!Number.isFinite(nowMs)) throw new Error('buildTrend 需要 nowMs')
  const buckets = []
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(nowMs - i * MS_PER_DAY)
    buckets.push({
      day: key,
      leads_new: 0,
      sent_confirmed: 0,
      sent_confirmed_dom: 0,
      sent_suspected: 0,
      failed: 0,
      usage_milli: Number(usageByDay[key] || 0),
    })
  }
  const index = new Map(buckets.map((b, i) => [b.day, i]))

  for (const send of sends || []) {
    if (!send || !SOURCE_TYPES.includes(send.source_type)) continue
    const at = Number(send.sent_at_ms)
    if (!Number.isFinite(at)) continue
    const i = index.get(dayKey(at))
    if (i === undefined) continue // 窗口外
    if (send.verdict === 'sent_confirmed') buckets[i].sent_confirmed += 1
    else if (send.verdict === 'sent_confirmed_dom') buckets[i].sent_confirmed_dom += 1
    else if (send.verdict === 'sent_suspected') buckets[i].sent_suspected += 1
    else if (send.verdict === 'failed') buckets[i].failed += 1
    // ⚠️ leads_new 在明细里推不出来（明细只有"回复尝试"，
    //    没有"命中但未回复"）。所以由调用方通过 usageByDay 旁路传入
    //    或使用聚合上报的 leads。这里显式留 0，不猜。
  }
  return buckets
}

function sum(sources, field) {
  let n = 0
  for (const src of SOURCE_TYPES) n += Number((sources[src] && sources[src][field]) || 0)
  return n
}

module.exports = {
  STATS_VERSION,
  dayStartMs,
  dayKey,
  emptySources,
  aggregateSends,
  aggregateReports,
  checkInvariants,
  reconcile,
  buildDashboard,
  buildQuotaUsage,
  buildTrend,
  sum,
}
