'use strict'

// license-server/api/routes-audit.js
//
// 心跳、审计上报、聚合上报。
//
// 这组接口承载两条红线：
//   · 红线 1：心跳下发 policy，接收客户端 ack 并写 policy_ack_log 存证
//   · 红线 3：audit/sends 是**唯一计费依据**，且只传哈希不传原文

const { AppError } = require('../../shared/lib/errors')
const { SOURCE_TYPES, SOURCE_COUNTERS, VERDICTS, CONFIRM_SIGNALS, FAILURE_REASONS, PLATFORM_ENDPOINTS } =
  require('../../shared/lib/protocol')
const { buildPolicy, deriveDayIndex, validateClientLimits, tierTableForClient } = require('../domain/policy')
const { settleSendBatch, usedQuota, dailyMaxFor } = require('../domain/billing')
const { buildQuotaNotice } = require('./quota-notice')

const AUDIT_BATCH_MAX = 500
const CONFIG_AUDIT_BATCH_MAX = 200

/** 取当前全局策略版本。 */
function policyVersionOf(db) {
  const row = db.prepare('SELECT policy_version FROM policy WHERE account_id IS NULL').get()
  return row ? Number(row.policy_version) : 1
}

// ═══════════════════════════════════════════════════════════
// POST /heartbeat
// ═══════════════════════════════════════════════════════════

/**
 * 心跳。
 *
 * 职责（契约 §4.5）：
 *   · 更新在线状态（`online_seconds` **仅运营统计，不参与计费**）
 *   · 下发策略；若版本变化则要求客户端重新 ack
 *   · 接收 `applied_limits` 并校验"只能更保守"
 *   · 余额 ≤ 0 → 返回 402 拒绝续期（客户端 60 秒内停机）
 */
function heartbeat(ctx) {
  const { db, session, body, nowMs, config } = ctx

  const policyVersion = policyVersionOf(db)
  const dayIndex = deriveDayIndex(Number(session.first_login_ms || nowMs), nowMs)
  const policy = buildPolicy({
    accountId: session.account_id, accountDayIndex: dayIndex, policyVersion, nowMs,
  })

  // ── 红线 1：校验客户端上报的生效值"只能更保守" ──────────
  // ⚠️ 更激进的配置**整批拒绝**（POLICY_VIOLATION），并记录该次越权尝试
  //    供举证——这是红线 3 "能回答用户是否主动调高过"的数据来源。
  const appliedLimits = body.applied_limits || null
  let violation = null
  try {
    validateClientLimits(appliedLimits, policy)
  } catch (e) {
    if (e.code !== 'POLICY_VIOLATION' && e.code !== 'POLICY_TIER_UNKNOWN') throw e
    violation = e
    recordConfigChange(db, {
      accountId: session.account_id,
      changeId: `hb-violation-${session.id}-${body.seq}`,
      instanceId: instanceOf(body, session),
      changedAtMs: nowMs,
      source: 'user',
      actor: 'local_user',
      fieldKey: e.detail && e.detail.field ? `limits.${e.detail.source_type || ''}.${e.detail.field}` : 'unknown',
      oldValue: null,
      newValue: JSON.stringify(e.detail && e.detail.reported),
      applied: false,
      rejectCode: e.code,
      policyVersion,
      nowMs,
    })
  }

  // ── ack 存证（红线 3）────────────────────────────────────
  // ⚠️ 必须记录**实际生效值**（客户端上报的 applied_limits），
  //    而不只是"服务端下发了什么"。出事时要能回答
  //    "当时实际生效的策略是什么"——只记下发值无法自证。
  if (appliedLimits && !violation) {
    ackPolicy(db, {
      accountId: session.account_id,
      instanceId: instanceOf(body, session),
      policy,
      appliedLimitsJson: JSON.stringify(appliedLimits),
      nowMs,
    })
  }

  // ── 额度（按渠道）────────────────────────────────────────
  const dailyQuota = {}
  for (const src of SOURCE_TYPES) {
    const { max } = dailyMaxFor(dayIndex, src)
    const used = usedQuota(db, session.account_id, src, nowMs)
    dailyQuota[src] = { max, used, remaining: Math.max(0, max - used) }
  }

  // ── 余额与停机判定 ───────────────────────────────────────
  const credit = db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(session.account_id)
  const balanceMilli = credit ? Number(credit.balance_milli) : 0
  const billing = db.prepare('SELECT state FROM account_billing WHERE account_id = ?').get(session.account_id)
  const billingState = billing ? billing.state : 'active'

  const commands = []
  let state = 'active'
  let httpStatusHint = 200

  if (balanceMilli <= 0) {
    state = 'exhausted'
    httpStatusHint = 402
    commands.push({ type: 'pause_engine', reason: 'CREDIT_EXHAUSTED' })
  } else if (!policy.sending_enabled) {
    state = 'observation'
    commands.push({ type: 'pause_engine', reason: 'POLICY_SENDING_DISABLED' })
  }

  const response = {
    ok: true,
    protocol_version: config.protocolVersion,
    state,
    billing_state: billingState,
    // ⚠️ 仅运营统计。契约明确：**任何情况下不得换算成积分**。
    online_seconds: Number(body.online_seconds || 0),
    online_seconds_note: 'not_billable',
    server_time_ms: nowMs,
    clock_skew_ms: Number(body.client_time_ms ? nowMs - Number(body.client_time_ms) : 0),
    policy,
    policy_changed: body.applied_policy_version !== policyVersion,
    policy_ack_required: !appliedLimits || body.applied_policy_version !== policyVersion,
    daily_quota: dailyQuota,
    credit: {
      balance_milli: balanceMilli,
      credit_per_reply_milli: config.creditPerReplyMilli,
      replies_affordable: Math.floor(Math.max(balanceMilli, 0) / config.creditPerReplyMilli),
    },
    quota_notice: buildQuotaNotice({
      policy, config, plan: loadPlan(db, session.account_id),
      balanceMilli, nowMs,
    }),
    commands,
    pending_send_count: Number(body.pending_send_count || 0),
  }

  if (violation) {
    // 越权不阻断心跳，但必须在响应里明确告知，客户端须立即降回
    response.policy_violation = {
      code: violation.code,
      message: violation.message,
      detail: violation.detail,
      action_required: '立即把本地上限降到服务端值并重新 ack',
    }
  }

  if (httpStatusHint === 402) {
    throw new AppError('CREDIT_EXHAUSTED', '积分不足，自动回复已暂停，请联系客服充值', {
      balance_milli: balanceMilli,
      credit_per_reply_milli: config.creditPerReplyMilli,
    })
  }

  return response
}

function loadPlan(db, accountId) {
  const acc = db.prepare('SELECT plan_id FROM account WHERE account_id = ?').get(accountId)
  if (!acc || !acc.plan_id) return null
  return db.prepare('SELECT * FROM plan WHERE plan_id = ?').get(acc.plan_id) || null
}

/**
 * 写 policy_ack_log。同 (account, instance, version) 已存在则只更新 last_seen。
 *
 * ⚠️ `instance_id` 是表的 NOT NULL 分区键，但契约 §4.5 的心跳字段表里
 *    **没有**这个字段——只有 `instances[]`。早期实现直接取 `body.instance_id`，
 *    于是任何按契约实现（不传该字段）的客户端都会让这条 INSERT 抛
 *    NOT NULL 约束错误，**ack 存证永远写不进去**，而红线 3 恰恰要求
 *    这张表能回答"当时实际生效的策略是什么"。
 *
 *    因此这里做兜底推导，保证一定拿到一个稳定非空的键：
 *      显式 instance_id → instances[] 首项 → device_id
 */
function instanceOf(body, session) {
  const explicit = body && body.instance_id
  if (explicit) return String(explicit)
  const list = body && body.instances
  if (Array.isArray(list) && list.length && list[0] && list[0].instance_id) {
    return String(list[0].instance_id)
  }
  return String((body && body.device_id) || session.device_id || 'unknown')
}

function ackPolicy(db, { accountId, instanceId, policy, appliedLimitsJson, nowMs }) {
  db.prepare(`
    INSERT INTO policy_ack_log (
      account_id, instance_id, policy_version, policy_hash, account_tier,
      account_day_index, applied_limits_json, first_ack_at_ms, last_seen_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id, instance_id, policy_version) DO UPDATE SET
      last_seen_at_ms = excluded.last_seen_at_ms,
      applied_limits_json = excluded.applied_limits_json
  `).run(
    accountId, instanceId, policy.policy_version, policy.policy_hash, policy.account_tier,
    policy.account_day_index, appliedLimitsJson, nowMs, nowMs
  )
}

/** 写配置变更审计（红线 3）。 */
function recordConfigChange(db, c) {
  db.prepare(`
    INSERT INTO audit_config_changes (
      change_id, account_id, instance_id, changed_at_ms, source, actor,
      field_key, old_value, new_value, applied, reject_code, policy_version, received_at_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(change_id) DO NOTHING
  `).run(
    c.changeId, c.accountId, c.instanceId || null, c.changedAtMs, c.source, c.actor || null,
    c.fieldKey, c.oldValue === undefined ? null : c.oldValue,
    c.newValue === undefined ? null : c.newValue,
    c.applied ? 1 : 0, c.rejectCode || null, c.policyVersion || null, c.nowMs
  )
}

// ═══════════════════════════════════════════════════════════
// GET /policy/current
// ═══════════════════════════════════════════════════════════

function policyCurrent(ctx) {
  const { db, session, nowMs } = ctx
  const policyVersion = policyVersionOf(db)
  const dayIndex = deriveDayIndex(Number(session.first_login_ms || nowMs), nowMs)
  const policy = buildPolicy({
    accountId: session.account_id, accountDayIndex: dayIndex, policyVersion, nowMs,
  })
  return { ok: true, server_time_ms: nowMs, policy, ...tierTableForClient() }
}

// ═══════════════════════════════════════════════════════════
// POST /audit/sends —— 唯一计费依据
// ═══════════════════════════════════════════════════════════

function auditSends(ctx) {
  const { db, session, body, nowMs, config } = ctx

  const sends = body.sends
  if (!Array.isArray(sends) || sends.length === 0) {
    throw new AppError('AUDIT_SEND_INVALID', 'sends 必须是非空数组')
  }
  if (sends.length > AUDIT_BATCH_MAX) {
    throw new AppError('AUDIT_BATCH_TOO_LARGE', `单批最多 ${AUDIT_BATCH_MAX} 条`, {
      reported: sends.length, max: AUDIT_BATCH_MAX,
    })
  }

  const policyVersion = policyVersionOf(db)
  const dayIndex = deriveDayIndex(Number(session.first_login_ms || nowMs), nowMs)

  // 逐条校验字段（含隐私边界）
  for (const s of sends) validateSendShape(s)

  const result = settleSendBatch(db, {
    accountId: session.account_id,
    accountDayIndex: dayIndex,
    policyVersion,
    creditPerReplyMilli: config.creditPerReplyMilli,
    billDomConfirmed: config.billDomConfirmed === true,
    nowMs,
    sends,
  })

  return {
    ...result,
    reconciliation: reconcileAgainstReport(db, session.account_id, body, result),
  }
}

/**
 * 字段形状校验。
 *
 * ⚠️ 隐私边界（红线 3）：只允许哈希与枚举，**禁止原文**。
 *    这里显式拒绝任何看起来像原文的字段名——宁可误拒也不能让
 *    评论/回复内容进入我们的库。
 */
const FORBIDDEN_FIELDS = Object.freeze([
  'text', 'content', 'reply_text', 'comment_text', 'raw', 'nickname', 'nick',
  'avatar_url', 'profile_url', 'sec_uid', 'user_id', 'cookie', 'phone',
])

function validateSendShape(s) {
  if (!s || typeof s !== 'object') {
    throw new AppError('AUDIT_SEND_INVALID', '明细必须是对象')
  }
  for (const f of ['send_id', 'source_type', 'verdict', 'sent_at_ms']) {
    if (s[f] === undefined || s[f] === null || s[f] === '') {
      throw new AppError('AUDIT_SEND_INVALID', `明细缺少必填字段 ${f}`, { send_id: s.send_id || null })
    }
  }
  if (!SOURCE_TYPES.includes(s.source_type)) {
    throw new AppError('AUDIT_SEND_INVALID', `未知来源类型 ${s.source_type}`, { allowed: SOURCE_TYPES })
  }
  if (!VERDICTS.includes(s.verdict)) {
    throw new AppError('AUDIT_SEND_INVALID', `未知判定 ${s.verdict}`, { allowed: VERDICTS })
  }
  const ev = s.evidence || {}
  if (ev.confirm_signal !== undefined && !CONFIRM_SIGNALS.includes(ev.confirm_signal)) {
    throw new AppError('AUDIT_SEND_INVALID', `未知确认信号 ${ev.confirm_signal}`, { allowed: CONFIRM_SIGNALS })
  }
  // ⚠️ platform_endpoint 是闭集白名单，禁止完整 URL 与域名
  if (ev.platform_endpoint !== undefined && ev.platform_endpoint !== null) {
    if (!PLATFORM_ENDPOINTS.includes(ev.platform_endpoint)) {
      throw new AppError('AUDIT_SEND_INVALID',
        `platform_endpoint 必须是闭集白名单中的路径片段，禁止完整 URL 或域名`,
        { reported: ev.platform_endpoint, allowed: PLATFORM_ENDPOINTS })
    }
  }
  if (s.failure_reason !== undefined && s.failure_reason !== null &&
      !FAILURE_REASONS.includes(s.failure_reason)) {
    throw new AppError('AUDIT_SEND_INVALID', `未知失败原因 ${s.failure_reason}`, { allowed: FAILURE_REASONS })
  }
  // 隐私：拒绝看起来像原文的字段
  for (const f of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(s, f)) {
      throw new AppError('REPORT_PRIVACY_VIOLATION',
        `明细中不得包含字段 ${f}（只允许哈希，见红线 3）`, { field: f })
    }
  }
}

/** 与客户端聚合数字对账（以明细为准）。 */
function reconcileAgainstReport(db, accountId, body, result) {
  const reported = body.reported_confirmed
  if (reported === undefined || reported === null) {
    return { detail_confirmed: countConfirmed(result), reported_confirmed: null, match: null, authoritative_source: 'audit_sends' }
  }
  const detail = countConfirmed(result)
  return {
    detail_confirmed: detail,
    reported_confirmed: Number(reported),
    match: detail === Number(reported),
    audit_flags: detail === Number(reported) ? [] : ['report_mismatch'],
    authoritative_source: 'audit_sends',
  }
}

function countConfirmed(result) {
  return result.results.filter((r) => r.verdict === 'sent_confirmed').length
}

// ═══════════════════════════════════════════════════════════
// POST /audit/config-changes
// ═══════════════════════════════════════════════════════════

function auditConfigChanges(ctx) {
  const { db, session, body, nowMs } = ctx

  const changes = body.changes
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new AppError('AUDIT_CONFIG_INVALID', 'changes 必须是非空数组')
  }
  if (changes.length > CONFIG_AUDIT_BATCH_MAX) {
    throw new AppError('AUDIT_BATCH_TOO_LARGE', `单批最多 ${CONFIG_AUDIT_BATCH_MAX} 条`, {
      reported: changes.length, max: CONFIG_AUDIT_BATCH_MAX,
    })
  }

  const policyVersion = policyVersionOf(db)
  const results = []

  for (const c of changes) {
    if (!c || !c.change_id || !c.field_key) {
      throw new AppError('AUDIT_CONFIG_INVALID', '每条变更必须有 change_id 与 field_key')
    }
    if (!['user', 'server_policy', 'default'].includes(c.source)) {
      throw new AppError('AUDIT_CONFIG_INVALID', `未知变更来源 ${c.source}`, {
        allowed: ['user', 'server_policy', 'default'],
      })
    }
    // 隐私：变更审计同样禁止写入正文
    for (const f of FORBIDDEN_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(c, f)) {
        throw new AppError('REPORT_PRIVACY_VIOLATION', `变更审计不得包含字段 ${f}`, { field: f })
      }
    }

    const before = db.prepare('SELECT change_id FROM audit_config_changes WHERE change_id = ?').get(c.change_id)
    recordConfigChange(db, {
      changeId: c.change_id,
      accountId: session.account_id,
      instanceId: instanceOf(body, session),
      changedAtMs: Number(c.changed_at_ms || nowMs),
      source: c.source,
      actor: c.actor || 'local_user',
      fieldKey: c.field_key,
      oldValue: c.old_value === undefined ? null : String(c.old_value),
      newValue: c.new_value === undefined ? null : String(c.new_value),
      applied: c.applied !== false,
      rejectCode: c.reject_code || null,
      policyVersion,
      nowMs,
    })
    results.push({ change_id: c.change_id, accepted: true, duplicate: Boolean(before) })
  }

  return { ok: true, results, audit_flags: [] }
}

// ═══════════════════════════════════════════════════════════
// POST /usage/report —— 仅聚合统计，**不是计费依据**
// ═══════════════════════════════════════════════════════════

function usageReport(ctx) {
  const { db, session, body, nowMs } = ctx

  const reportId = body.report_id
  if (!reportId) throw new AppError('REPORT_INVALID', '缺少 report_id（幂等键）')

  const existing = db.prepare('SELECT report_id FROM usage_report WHERE report_id = ?').get(reportId)
  if (existing) {
    return { ok: true, duplicate: true, report_id: reportId, note: '幂等命中，未重复入账' }
  }

  const sources = body.sources
  if (!sources || typeof sources !== 'object') {
    throw new AppError('REPORT_INVALID', '缺少 sources')
  }
  for (const src of SOURCE_TYPES) {
    if (!sources[src] || typeof sources[src] !== 'object') {
      throw new AppError('REPORT_INVALID', `sources 必须包含全部三个来源（${src} 缺失）`, {
        required: SOURCE_TYPES,
      })
    }
    for (const k of SOURCE_COUNTERS) {
      if (sources[src][k] !== undefined && !Number.isInteger(sources[src][k])) {
        throw new AppError('REPORT_INVALID', `sources.${src}.${k} 必须是整数`)
      }
    }
  }

  db.prepare(`
    INSERT INTO usage_report (
      report_id, account_id, instance_id, window_start_ms, window_end_ms,
      online_seconds, payload_json, received_at_ms
    ) VALUES (?,?,?,?,?,?,?,?)
  `).run(
    reportId, session.account_id,
    instanceOf(body, session),
    body.window_start_ms === undefined ? null : Number(body.window_start_ms),
    body.window_end_ms === undefined ? null : Number(body.window_end_ms),
    // ⚠️ 仅运营统计。契约：任何情况下不得换算成积分。
    Number(body.online_seconds || 0),
    JSON.stringify(sources),
    nowMs
  )

  return {
    ok: true,
    duplicate: false,
    report_id: reportId,
    credit_consumed_milli: 0,
    note: '聚合上报仅用于统计，不参与计费（计费只认 audit/sends 明细）',
  }
}

module.exports = {
  AUDIT_BATCH_MAX,
  CONFIG_AUDIT_BATCH_MAX,
  policyVersionOf,
  heartbeat,
  policyCurrent,
  auditSends,
  auditConfigChanges,
  usageReport,
  validateSendShape,
  recordConfigChange,
  ackPolicy,
}
