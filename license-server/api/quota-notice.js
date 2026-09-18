'use strict'

// license-server/api/quota-notice.js
//
// 额度文案（`quota_notice`）的构造。
//
// ⚠️ 契约硬要求（protocol.md §4.14）：
//   客户端必须**原样展示** headline 与 detail，不得改写、折叠或隐藏。
//   展示位置四处：套餐展示页、充值页、首次登录弹窗、余额不足提示。
//
// ⚠️ 更重要的要求：**文案里的所有数字必须由 tier_table 实时推导，
//    禁止硬编码**。理由：安全上限会随平台风控变化而调整，若文案写死，
//    改上限后会出现"界面写每日 70 条、套餐却按旧值折算"这类错误告知，
//    直接成为售后纠纷与举证不利的依据。

const { SOURCE_TYPES } = require('../../shared/lib/protocol')
const { TIER_TABLE, stableDailyMaxTotal, planCreditsFor, minPlanCredit } = require('../domain/policy')

/** 渠道中文名，用于文案。 */
const SOURCE_LABELS = Object.freeze({
  comment: '评论',
  live_danmaku: '弹幕',
  dm: '私信',
})

/**
 * 构造 quota_notice。
 *
 * @param {object} opts
 * @param {object} opts.policy 当前账号的 policy
 * @param {object} opts.config 服务端配置
 * @param {object|null} opts.plan 当前套餐（可为 null）
 * @param {number} opts.balanceMilli 当前余额
 * @param {number} opts.nowMs
 */
function buildQuotaNotice({ policy, config, plan, balanceMilli, nowMs }) {
  const creditPerReplyMilli = config.creditPerReplyMilli
  const stableTotal = stableDailyMaxTotal()
  const stable = TIER_TABLE.find((t) => t.tier === 'stable')

  const validDays = plan ? Number(plan.valid_days) : 180
  const planCredits = plan ? Number(plan.credits) : planCreditsFor(validDays)
  const dailyCapTotal = Object.values(policy.limits).reduce((s, l) => s + l.daily_max, 0)
  const dailyCapDetail = Object.fromEntries(
    SOURCE_TYPES.map((s) => [s, policy.limits[s].daily_max])
  )
  const creditsPerDayAtCap = dailyCapTotal * (creditPerReplyMilli / 1000)

  // 观察期文案必须特殊化——否则商家会困惑"为什么一条都发不出去"
  if (!policy.sending_enabled || dailyCapTotal === 0) {
    const nextTier = policy.next_tier
    const daysToNext = policy.days_until_next_tier
    const warm = TIER_TABLE.find((t) => t.tier === 'warm_up')
    const warmDetail = SOURCE_TYPES
      .map((s) => `${SOURCE_LABELS[s]} ${warm.limits[s].daily_max} 条/天`)
      .join('、')

    return {
      headline: `当前处于观察期，仅采集线索，${
        daysToNext === null ? '稍后' : `第 ${policy.account_day_index + (daysToNext || 0)} 天`
      }开始可发送`,
      detail:
        `观察期（第 ${policy.current_tier_from || 1}–3 天）平台发送上限为 0：` +
        `客户端只采集线索，不发送任何评论、弹幕或私信。` +
        `第 4 天起进入${warm.tier === 'warm_up' ? '预热期' : nextTier}（${warmDetail}）。` +
        `积分只对平台确认成功的回复扣减，失败与被风控拒绝不扣费。`,
      tier: policy.account_tier,
      account_day_index: policy.account_day_index,
      collect_only: policy.collect_only,
      sending_enabled: policy.sending_enabled,
      next_tier: nextTier,
      next_tier_at_day: daysToNext === null ? null : policy.account_day_index + daysToNext,
      daily_cap_total: dailyCapTotal,
      daily_cap_detail: dailyCapDetail,
      credit_per_reply_milli: creditPerReplyMilli,
      balance_milli: balanceMilli,
      replies_affordable: Math.floor(Math.max(balanceMilli, 0) / creditPerReplyMilli),
      valid_days: validDays,
      credits: planCredits,
      credits_per_day_at_cap: creditsPerDayAtCap,
      estimated_days_at_cap: creditsPerDayAtCap > 0
        ? Math.floor(planCredits / creditsPerDayAtCap) : null,
      estimated_days_at_current_rate: null, // 需历史消耗数据，由看板接口补充
      min_plan_credit: minPlanCredit(),
      generated_from_policy_version: policy.policy_version,
      generated_at_ms: nowMs,
      note: '安全上限会限制实际消耗速度，因此套餐按期而非按量承诺；额度按积分计量，有效期按 valid_days 计算。',
    }
  }

  // 正常（可发送）文案 —— 数字全部来自策略表
  const stableDetail = SOURCE_TYPES
    .map((s) => `${SOURCE_LABELS[s]} ${stable.limits[s].daily_max}`)
    .join(' / ')

  const detail =
    `平台安全上限由服务端下发且客户端无法调高：稳定期每日最多 ${stableTotal} 条` +
    `（${stableDetail}）。` +
    `${validDays} 天套餐 ${planCredits} 积分 = 按每日上限连续用满 ${validDays} 天折算；` +
    `实际发送量受当日上限约束，未用完的额度不会顺延为额外发送量。` +
    `积分只对平台确认成功的回复扣减，失败与被风控拒绝不扣费。`

  return {
    headline: '套餐是预付额度，不等于无限发送',
    detail,
    tier: policy.account_tier,
    account_day_index: policy.account_day_index,
    collect_only: policy.collect_only,
    sending_enabled: policy.sending_enabled,
    next_tier: policy.next_tier,
    next_tier_at_day: policy.days_until_next_tier === null
      ? null : policy.account_day_index + policy.days_until_next_tier,
    daily_cap_total: dailyCapTotal,
    daily_cap_detail: dailyCapDetail,
    credit_per_reply_milli: creditPerReplyMilli,
    balance_milli: balanceMilli,
    replies_affordable: Math.floor(Math.max(balanceMilli, 0) / creditPerReplyMilli),
    valid_days: validDays,
    credits: planCredits,
    credits_per_day_at_cap: creditsPerDayAtCap,
    estimated_days_at_cap: creditsPerDayAtCap > 0
      ? Math.floor(planCredits / creditsPerDayAtCap) : null,
    estimated_days_at_current_rate: null,
    min_plan_credit: minPlanCredit(),
    generated_from_policy_version: policy.policy_version,
    generated_at_ms: nowMs,
    note: '安全上限会限制实际消耗速度，因此套餐按期而非按量承诺；额度按积分计量，有效期按 valid_days 计算。',
  }
}

module.exports = { buildQuotaNotice, SOURCE_LABELS }
