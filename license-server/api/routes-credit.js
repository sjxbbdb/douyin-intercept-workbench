'use strict'

// license-server/api/routes-credit.js
//
// 积分查询、台账、套餐、卡密兑换。
//
// ⚠️ 计费相关的写入**只能**通过 billing.settleSendBatch 与 grantCredits，
//    本文件不得直接 UPDATE credit.balance_milli——那会绕过事务与台账。

const crypto = require('node:crypto')
const { AppError } = require('../../shared/lib/errors')
const { grantCredits, reconcile } = require('../domain/billing')
const { planCreditsFor, minPlanCredit, stableDailyMaxTotal } = require('../domain/policy')

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去掉易混淆字符
const CODE_GROUPS = 4
const CODE_GROUP_LEN = 5

// ═══════════════════════════════════════════════════════════
// GET /credit/balance
// ═══════════════════════════════════════════════════════════

function creditBalance(ctx) {
  const { db, session, nowMs, config } = ctx
  const credit = db.prepare('SELECT * FROM credit WHERE account_id = ?').get(session.account_id)
  const billing = db.prepare('SELECT state FROM account_billing WHERE account_id = ?').get(session.account_id)
  const balanceMilli = credit ? Number(credit.balance_milli) : 0
  const unit = config.creditPerReplyMilli

  return {
    ok: true,
    server_time_ms: nowMs,
    credit: {
      balance_milli: balanceMilli,
      credit_per_reply_milli: unit,
      // 剩余可发条数（向下取整：不足一条不能算一条）
      replies_affordable: Math.floor(Math.max(balanceMilli, 0) / unit),
      used_today_milli: usedMilli(db, session.account_id, dayStart(nowMs), nowMs),
      used_week_milli: usedMilli(db, session.account_id, weekStart(nowMs), nowMs),
      used_month_milli: usedMilli(db, session.account_id, monthStart(nowMs), nowMs),
      updated_at_ms: credit ? Number(credit.updated_at_ms) : nowMs,
    },
    billing_state: billing ? billing.state : 'active',
  }
}

function usedMilli(db, accountId, fromMs, toMs) {
  const r = db.prepare(`
    SELECT COALESCE(-SUM(delta_milli), 0) AS m FROM credit_ledger
    WHERE account_id = ? AND kind = 'consume' AND settled_at_ms >= ? AND settled_at_ms < ?
  `).get(accountId, fromMs, toMs)
  return Number(r.m)
}

const TZ = 480 * 60 * 1000
function dayStart(ms) { return Math.floor((ms + TZ) / 86400000) * 86400000 - TZ }
function weekStart(ms) {
  const d = dayStart(ms)
  // 以周一为起点
  const dayIdx = new Date(d + TZ).getUTCDay() // 0=周日
  const offset = dayIdx === 0 ? 6 : dayIdx - 1
  return d - offset * 86400000
}
function monthStart(ms) {
  const dt = new Date(ms + TZ)
  return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1) - TZ
}

// ═══════════════════════════════════════════════════════════
// GET /credit/ledger
// ═══════════════════════════════════════════════════════════

function creditLedger(ctx) {
  const { db, session, query, nowMs } = ctx
  const granularity = String(query.granularity || 'summary')
  const fromMs = query.from_ms ? Number(query.from_ms) : weekStart(nowMs)
  const toMs = query.to_ms ? Number(query.to_ms) : nowMs

  if (!['summary', 'daily', 'raw'].includes(granularity)) {
    throw new AppError('AUTH_INVALID_REQUEST', `未知的 granularity ${granularity}`, {
      allowed: ['summary', 'daily', 'raw'],
    })
  }

  const accounts = db.prepare('SELECT account_id FROM credit WHERE account_id = ?').get(session.account_id)
  if (!accounts) throw new AppError('CREDIT_LEDGER_NOT_FOUND', '该账号尚无积分记录')

  const rows = db.prepare(`
    SELECT * FROM credit_ledger
    WHERE account_id = ? AND settled_at_ms >= ? AND settled_at_ms <= ?
    ORDER BY settled_at_ms ASC
  `).all(session.account_id, fromMs, toMs)

  const byKind = {}
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] || 0) + Number(r.delta_milli)
  }
  const netMilli = Object.values(byKind).reduce((s, v) => s + v, 0)

  const out = {
    ok: true,
    server_time_ms: nowMs,
    granularity,
    window: { from_ms: fromMs, to_ms: toMs },
    summary: {
      net_milli: netMilli,
      recharge_milli: byKind.recharge || 0,
      redeem_milli: byKind.redeem || 0,
      grant_milli: byKind.grant || 0,
      adjust_milli: byKind.adjust || 0,
      refund_milli: byKind.refund || 0,
      usage_milli: -(byKind.consume || 0),
    },
    tz_offset_minutes: 480,
  }

  if (granularity === 'daily') {
    const buckets = {}
    for (const r of rows) {
      const d = dayStart(Number(r.settled_at_ms))
      if (!buckets[d]) buckets[d] = { day_start_ms: d, consume_milli: 0, income_milli: 0 }
      const v = Number(r.delta_milli)
      if (v < 0) buckets[d].consume_milli += -v
      else buckets[d].income_milli += v
    }
    out.days = Object.values(buckets).sort((a, b) => a.day_start_ms - b.day_start_ms)
  }

  if (granularity === 'raw') {
    out.entries = rows.map((r) => ({
      entry_id: `le_${r.id}`,
      kind: r.kind,
      delta_milli: Number(r.delta_milli),
      balance_after_milli: Number(r.balance_after_milli),
      ref_send_id: r.ref_send_id || null,
      ref_code_hash: r.ref_code_hash || null,
      operator: r.operator,
      note: r.note,
      settled_at_ms: Number(r.settled_at_ms),
    }))
  }

  return out
}

// ═══════════════════════════════════════════════════════════
// GET /account/plan
// ═══════════════════════════════════════════════════════════

function accountPlan(ctx) {
  const { db, session, nowMs, config } = ctx
  const plans = db.prepare('SELECT * FROM plan WHERE active = 1 ORDER BY plan_id').all()
  const acc = db.prepare('SELECT plan_id, plan_expires_ms FROM account WHERE account_id = ?').get(session.account_id)
  const credit = db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(session.account_id)

  return {
    ok: true,
    server_time_ms: nowMs,
    credit_per_reply_milli: config.creditPerReplyMilli,
    // ⚠️ 这两个数字必须由 tier_table 实时推导，禁止硬编码
    stable_daily_max_total: stableDailyMaxTotal(),
    min_plan_credit: minPlanCredit(),
    plan_credit_formula: 'stable_daily_max_total × valid_days × plan_credit_ratio',
    plans: plans.map((p) => ({
      plan_id: p.plan_key,
      name: p.name,
      valid_days: Number(p.valid_days),
      credits: Number(p.credits),
      credits_milli: Number(p.credits) * config.creditPerReplyMilli,
      price_cents: Number(p.price_cents),
      // ⚠️ 价格由商务配置。标记为占位值，**不得作为定价依据**。
      price_is_placeholder: Number(p.price_is_placeholder) === 1,
      active: Number(p.active) === 1,
      // hours 已废弃（计费从按小时改为按条数），恒为 null
      hours: null,
    })),
    current: acc && acc.plan_id ? {
      plan_id: acc.plan_id,
      expires_ms: acc.plan_expires_ms ? Number(acc.plan_expires_ms) : null,
      remaining_days: acc.plan_expires_ms
        ? Math.max(0, Math.ceil((Number(acc.plan_expires_ms) - nowMs) / 86400000)) : null,
      credits_remaining_milli: credit ? Number(credit.balance_milli) : 0,
    } : null,
  }
}

// ═══════════════════════════════════════════════════════════
// POST /credit/redeem
// ═══════════════════════════════════════════════════════════

function redeem(ctx) {
  const { db, session, body, nowMs } = ctx

  const code = String(body.code || '').trim().toUpperCase()
  const requestId = String(body.request_id || '').trim()
  if (!code) throw new AppError('AUTH_INVALID_REQUEST', '缺少卡密')
  if (!requestId) throw new AppError('AUTH_INVALID_REQUEST', '缺少 request_id（幂等键）')

  const codeHash = sha256Hex(code)

  // 幂等：同一 request_id 重复提交返回首次结果
  const done = db.prepare(`
    SELECT * FROM redeem_code WHERE code_hash = ? AND used_by = ?
  `).get(codeHash, session.account_id)
  if (done && done.used_at_ms) {
    return {
      ok: true,
      code: 'CREDIT_REDEEM_ALREADY_DONE',
      credits: Number(done.credits),
      valid_days: done.valid_days === null ? null : Number(done.valid_days),
      redeemed_at_ms: Number(done.used_at_ms),
      note: '该卡密已在你的账号兑换过（幂等命中）',
    }
  }

  const row = db.prepare('SELECT * FROM redeem_code WHERE code_hash = ?').get(codeHash)
  if (!row) throw new AppError('CREDIT_REDEEM_CODE_INVALID', '卡密无效，请检查后重试')
  if (row.disabled_at_ms) throw new AppError('CREDIT_REDEEM_CODE_DISABLED', '该卡密已作废，请联系客服')
  if (row.used_by) throw new AppError('CREDIT_REDEEM_CODE_USED', '该卡密已被使用', {
    used_at_ms: Number(row.used_at_ms),
  })
  if (row.expires_at_ms && Number(row.expires_at_ms) < nowMs) {
    throw new AppError('CREDIT_REDEEM_CODE_EXPIRED', '该卡密已过期，请联系客服换新')
  }

  // 原子兑换：BEGIN IMMEDIATE + 条件更新，避免并发重复兑换
  db.exec('BEGIN IMMEDIATE')
  try {
    const upd = db.prepare(`
      UPDATE redeem_code SET used_by = ?, used_at_ms = ?
      WHERE code_hash = ? AND used_by IS NULL AND disabled_at_ms IS NULL
    `).run(session.account_id, nowMs, codeHash)
    if (Number(upd.changes) === 0) {
      throw new AppError('CREDIT_REDEEM_CODE_USED', '该卡密已被使用（并发兑换）')
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  const credits = Number(row.credits)
  const deltaMilli = credits * ctx.config.creditPerReplyMilli
  const g = grantCredits(db, {
    accountId: session.account_id,
    deltaMilli,
    kind: 'redeem',
    operator: `account:${session.account_id}`,
    note: `兑换卡密 ${code.slice(0, 4)}****`,
    nowMs,
    refCodeHash: codeHash,
  })

  // 卡密若带有效天数，延长套餐到期
  if (row.valid_days) {
    const acc = db.prepare('SELECT plan_id, plan_expires_ms FROM account WHERE account_id = ?').get(session.account_id)
    const base = Math.max(Number(acc.plan_expires_ms || 0), nowMs)
    const newExpiry = base + Number(row.valid_days) * 86400000
    db.prepare('UPDATE account SET plan_id = COALESCE(?, plan_id), plan_expires_ms = ?, status = ?, updated_at_ms = ? WHERE account_id = ?')
      .run(row.plan_id || null, newExpiry, 'active', nowMs, session.account_id)
  }

  return {
    ok: true,
    code: 'CREDIT_REDEEM_ALREADY_DONE',
    credits,
    valid_days: row.valid_days === null ? null : Number(row.valid_days),
    balance_milli: g.balance_milli,
    redeemed_at_ms: nowMs,
  }
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex')
}

// ═══════════════════════════════════════════════════════════
// 卡密生成（管理侧）
// ═══════════════════════════════════════════════════════════

/**
 * 生成一批卡密。
 *
 * ⚠️ 返回的明文卡密**只在此处出现一次**，库中只存哈希。
 *    调用方必须立即落盘/展示给操作者，之后无法再取回。
 */
function generateRedeemCodes(db, {
  count, credits, validDays, planId, batch, expiresAtMs, nowMs,
}) {
  if (!Number.isInteger(count) || count < 1 || count > 10000) {
    throw new AppError('AUTH_INVALID_REQUEST', 'count 必须是 1~10000 的整数')
  }
  if (!Number.isInteger(credits) || credits < 1) {
    throw new AppError('AUTH_INVALID_REQUEST', 'credits 必须是正整数')
  }

  const plain = []
  db.exec('BEGIN IMMEDIATE')
  try {
    const ins = db.prepare(`
      INSERT INTO redeem_code (
        code_hash, plan_id, kind, credits, valid_days, batch, created_at_ms, expires_at_ms
      ) VALUES (?,?,?,?,?,?,?,?)
    `)
    for (let i = 0; i < count; i++) {
      let code
      let tries = 0
      // 冲突重试（极小概率）
      for (;;) {
        code = makeCode()
        const hash = sha256Hex(code)
        const dup = db.prepare('SELECT id FROM redeem_code WHERE code_hash = ?').get(hash)
        if (!dup) {
          ins.run(hash, planId || null, planId ? 'plan' : 'credits', credits,
            validDays === undefined ? null : validDays, batch || '', nowMs,
            expiresAtMs === undefined ? null : expiresAtMs)
          break
        }
        if (++tries > 5) throw new AppError('SERVER_INTERNAL', '卡密生成冲突过多，请重试')
      }
      plain.push(code)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  return { count, batch: batch || '', codes: plain }
}

/** 生成形如 XXXX-XXXX-XXXX-XXXX 的卡密。 */
function makeCode() {
  const groups = []
  for (let g = 0; g < CODE_GROUPS; g++) {
    let s = ''
    const bytes = crypto.randomBytes(CODE_GROUP_LEN)
    for (let i = 0; i < CODE_GROUP_LEN; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
    groups.push(s)
  }
  return groups.join('-')
}

module.exports = {
  creditBalance,
  creditLedger,
  accountPlan,
  redeem,
  generateRedeemCodes,
  makeCode,
}
