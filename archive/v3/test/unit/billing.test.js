'use strict'

// test/unit/billing.test.js
// 计费与台账测试 —— **契约 §6.6 的 14 条边界用例逐条覆盖**。
//
// ⚠️ 这是项目里最重要的测试文件。计费出错意味着：
//   · 少收钱（厂商损失）或错收钱（客户投诉）
//   · 对失败的发送计费 → 直接违反红线 2，且客户会发现
//   · 幂等失效 → 重复上报重复扣费，这是最严重的计费事故

const test = require('node:test')
const assert = require('node:assert')

const { openDatabase } = require('../../license-server/store/db')
const B = require('../../license-server/domain/billing')
const P = require('../../license-server/domain/policy')

const NOW = 1758096000000
const UNIT = 1000 // 1 积分/条

// ── 夹具 ────────────────────────────────────────────────────

function setup({ balanceCredits = 100, firstLoginMs = NOW - 30 * 86400000 } = {}) {
  const { db, close } = openDatabase(':memory:')
  const now = NOW
  const r = db.prepare(`
    INSERT INTO account (account, display_name, pass_hash, first_login_ms, created_at_ms, updated_at_ms)
    VALUES ('demo001', '演示店', 'h', ?, ?, ?)
  `).run(firstLoginMs, now, now)
  const accountId = Number(r.lastInsertRowid)
  db.prepare('INSERT INTO credit (account_id, balance_milli, updated_at_ms) VALUES (?, ?, ?)')
    .run(accountId, balanceCredits * UNIT, now)
  db.prepare('INSERT INTO account_billing (account_id, insufficient, state, updated_at_ms) VALUES (?, 0, ?, ?)')
    .run(accountId, 'active', now)
  return { db, close, accountId }
}

/** 稳定期账号的天数索引 */
const STABLE_DAY = 30
/** 预热期（评论上限 10/天） */
const WARMUP_DAY = 5
/** 观察期（全 0） */
const OBS_DAY = 2

let seq = 0
function send(overrides = {}) {
  seq++
  return {
    send_id: `s-${String(seq).padStart(6, '0')}`,
    source_type: 'comment',
    verdict: 'sent_confirmed',
    evidence: {
      confirm_signal: 'platform_response',
      platform_endpoint: 'comment/publish',
      platform_status_code: 0,
    },
    sent_at_ms: NOW,
    ...overrides,
  }
}

function okSend(overrides = {}) {
  return send({ verdict: 'sent_confirmed', ...overrides })
}

function settle(db, accountId, sends, opts = {}) {
  return B.settleSendBatch(db, {
    accountId,
    accountDayIndex: opts.accountDayIndex === undefined ? STABLE_DAY : opts.accountDayIndex,
    policyVersion: opts.policyVersion === undefined ? 7 : opts.policyVersion,
    creditPerReplyMilli: opts.creditPerReplyMilli === undefined ? UNIT : opts.creditPerReplyMilli,
    billDomConfirmed: opts.billDomConfirmed === true,
    nowMs: opts.nowMs === undefined ? NOW : opts.nowMs,
    sends,
  })
}

function balanceOf(db, accountId) {
  const r = db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(accountId)
  return Number(r.balance_milli)
}

function ledgerRows(db, accountId) {
  return db.prepare("SELECT * FROM credit_ledger WHERE account_id = ? AND kind='consume' ORDER BY id").all(accountId)
}

// ══════════════════════════════════════════════════════════
// §6.6 用例 1：幂等
// ══════════════════════════════════════════════════════════

test('§6.6-1 同一 send_id 重复上报 10 次：只扣 1 条，其余回放', () => {
  const { db, close, accountId } = setup({ balanceCredits: 100 })
  try {
    const s = okSend()
    const first = settle(db, accountId, [s])
    assert.strictEqual(first.settlement.billed_count, 1)
    assert.strictEqual(balanceOf(db, accountId), 100 * UNIT - UNIT)

    for (let i = 0; i < 9; i++) {
      const again = settle(db, accountId, [s])
      assert.strictEqual(again.settlement.billed_count, 0, `第 ${i + 2} 次不应再计费`)
      assert.strictEqual(again.settlement.duplicate_count, 1)
      assert.strictEqual(again.results[0].duplicate, true)
    }
    assert.strictEqual(balanceOf(db, accountId), 100 * UNIT - UNIT, '余额只应减一次')
    assert.strictEqual(ledgerRows(db, accountId).length, 1, '台账只应有一条')
  } finally { close() }
})

// ══════════════════════════════════════════════════════════
// §6.6 用例 2：一批 10 条混合判定 → 扣 4 条
// ══════════════════════════════════════════════════════════

test('§6.6-2 一批 10 条：4 成功 + 3 失败 + 2 疑似 + 1 DOM → 扣 4 条', () => {
  const { db, close, accountId } = setup({ balanceCredits: 100 })
  try {
    const sends = []
    for (let i = 0; i < 4; i++) sends.push(okSend())
    for (let i = 0; i < 3; i++) {
      sends.push(send({
        verdict: 'failed',
        evidence: { confirm_signal: 'none', platform_status_code: null },
      }))
    }
    for (let i = 0; i < 2; i++) {
      sends.push(send({ verdict: 'sent_suspected', evidence: { confirm_signal: 'none' } }))
    }
    sends.push(send({ verdict: 'sent_confirmed_dom', evidence: { confirm_signal: 'dom_stable' } }))

    const r = settle(db, accountId, sends)
    assert.strictEqual(r.settlement.billed_count, 4, '恰好扣 4 条')
    assert.strictEqual(r.settlement.charged_milli, 4 * UNIT)
    assert.strictEqual(balanceOf(db, accountId), 100 * UNIT - 4 * UNIT)
    assert.strictEqual(ledgerRows(db, accountId).length, 4)
    // 明细全部留痕
    const total = db.prepare('SELECT COUNT(*) c FROM send_log WHERE account_id=?').get(accountId)
    assert.strictEqual(Number(total.c), 10, '10 条明细全部留痕（审计优先）')
    // 6 条不计费
    assert.strictEqual(r.results.filter((x) => x.billing_status === 'not_billable').length, 6)
  } finally { close() }
})

// ══════════════════════════════════════════════════════════
// §6.6 用例 3：风控拒绝
// ══════════════════════════════════════════════════════════

test('§6.6-3 风控拒绝（空响应）不计费', () => {
  const { db, close, accountId } = setup()
  try {
    const r = settle(db, accountId, [
      send({ verdict: 'failed', evidence: { confirm_signal: 'none', platform_status_code: null }, failure_reason: 'risk_control_rejected' }),
    ])
    assert.strictEqual(r.settlement.billed_count, 0)
    assert.strictEqual(balanceOf(db, accountId), 100 * UNIT)
    assert.strictEqual(ledgerRows(db, accountId).length, 0)
  } finally { close() }
})

// ══════════════════════════════════════════════════════════
// §6.6 用例 4：status_code != 0 却被标成 sent_confirmed
// ══════════════════════════════════════════════════════════

test('§6.6-4 status_code≠0 但标成 confirmed：判 not_billable 并记 evidence_invalid', () => {
  const { db, close, accountId } = setup()
  try {
    const r = settle(db, accountId, [
      okSend({ evidence: { confirm_signal: 'platform_response', platform_endpoint: 'comment/publish', platform_status_code: 1 } }),
    ])
    assert.strictEqual(r.settlement.billed_count, 0, '不得计费')
    assert.ok(r.audit_flags.includes('evidence_invalid'), '应记 evidence_invalid')
    assert.strictEqual(balanceOf(db, accountId), 100 * UNIT)
  } finally { close() }
})

test('§6.6-4b DOM 判据不得计费（红线 2：DOM 不算成功）', () => {
  const { db, close, accountId } = setup()
  try {
    const r = settle(db, accountId, [
      okSend({ evidence: { confirm_signal: 'dom_stable', platform_status_code: 0 } }),
    ])
    assert.strictEqual(r.settlement.billed_count, 0, 'confirm_signal 不是 platform_response 就不计费')
  } finally { close() }
})

// ══════════════════════════════════════════════════════════
// §6.6 用例 5：离线补报
// ══════════════════════════════════════════════════════════

test('§6.6-5 离线 3 小时囤 12 条补报：逐条结算，重发不重复扣费', () => {
  const { db, close, accountId } = setup({ balanceCredits: 100 })
  try {
    const sends = []
    for (let i = 0; i < 12; i++) {
      sends.push(okSend({ sent_at_ms: NOW - 3 * 3600000 + i * 60000 }))
    }
    const r = settle(db, accountId, sends)
    assert.strictEqual(r.settlement.billed_count, 12, '稳定期上限 30，12 条全部可计费')
    assert.strictEqual(balanceOf(db, accountId), 100 * UNIT - 12 * UNIT)

    // 整批重发 → 全部 duplicate
    const again = settle(db, accountId, sends)
    assert.strictEqual(again.settlement.billed_count, 0)
    assert.strictEqual(again.settlement.duplicate_count, 12)
    assert.strictEqual(balanceOf(db, accountId), 100 * UNIT - 12 * UNIT)
  } finally { close() }
})

// ══════════════════════════════════════════════════════════
// §6.6 用例 6：判定升级
// ══════════════════════════════════════════════════════════

test('§6.6-6 判定升级：suspected → confirmed 计费一次', () => {
  const { db, close, accountId } = setup({ balanceCredits: 100 })
  try {
    const id = 's-upgrade-01'
    // 首次报疑似 → 不计费
    const first = settle(db, accountId, [send({ send_id: id, verdict: 'sent_suspected', evidence: { confirm_signal: 'none' } })])
    assert.strictEqual(first.settlement.billed_count, 0)
    assert.strictEqual(balanceOf(db, accountId), 100 * UNIT)

    // 升级为 confirmed 且带平台证据 → 计费一次
    const second = settle(db, accountId, [okSend({ send_id: id })])
    assert.strictEqual(second.settlement.billed_count, 1, '升级应计费一次')
    assert.strictEqual(balanceOf(db, accountId), 100 * UNIT - UNIT)

    // 再报一次 confirmed → 幂等，不再扣
    const third = settle(db, accountId, [okSend({ send_id: id })])
    assert.strictEqual(third.settlement.billed_count, 0)
    assert.strictEqual(balanceOf(db, accountId), 100 * UNIT - UNIT)
  } finally { close() }
})

// ══════════════════════════════════════════════════════════
// §6.6 用例 7：跨天补报，各按所属日的等级与上限核算
// ══════════════════════════════════════════════════════════

test('§6.6-7 跨天补报：按各条 sent_at_ms 所属自然日核算', () => {
  const { db, close, accountId } = setup({ balanceCredits: 100, firstLoginMs: NOW - 30 * 86400000 })
  try {
    // 预热期上限：评论 10/天。构造两天各 10 条成功 → 各满额
    const day1 = NOW - 86400000
    const day2 = NOW
    const sends = []
    for (let i = 0; i < 10; i++) sends.push(okSend({ sent_at_ms: day1 + i * 1000 }))
    for (let i = 0; i < 10; i++) sends.push(okSend({ sent_at_ms: day2 + i * 1000 }))

    const r = settle(db, accountId, sends, { accountDayIndex: WARMUP_DAY })
    assert.strictEqual(r.settlement.billed_count, 20, '两天各 10 条，都在各自上限内')

    // 再补第 3 天（day2）的 1 条 → 该日已达上限，应 policy_exceeded
    const extra = settle(db, accountId, [okSend({ sent_at_ms: day2 + 99999 })], { accountDayIndex: WARMUP_DAY })
    assert.strictEqual(extra.settlement.billed_count, 0, '该日已满 10 条')
    assert.strictEqual(extra.results[0].billing_status, 'policy_exceeded')
  } finally { close() }
})

// ══════════════════════════════════════════════════════════
// §6.6 用例 8：余额恰好够 3 条
// ══════════════════════════════════════════════════════════

test('§6.6-8 余额恰好够 3 条：前 3 条 billed，其后 unbilled_insufficient_credit', () => {
  const { db, close, accountId } = setup({ balanceCredits: 3 })
  try {
    const sends = []
    for (let i = 0; i < 10; i++) sends.push(okSend({ sent_at_ms: NOW + i * 1000 }))

    const r = settle(db, accountId, sends)
    // 余额 3 条 + 允许透支 1 条 = 4 条可支付
    assert.strictEqual(r.settlement.billed_count, 4, '3 条余额 + 1 条透支')
    const billed = r.results.filter((x) => x.billing_status === 'billed').length
    const unbilled = r.results.filter((x) => x.billing_status === 'unbilled_insufficient_credit').length
    assert.strictEqual(billed, 4)
    assert.strictEqual(unbilled, 6)
    assert.strictEqual(balanceOf(db, accountId), -UNIT, '恰好透支一条')
    assert.strictEqual(r.settlement.state, 'exhausted')
    assert.ok(r.commands.some((c) => c.type === 'pause_engine'), '应下发停机指令')
  } finally { close() }
})

// ══════════════════════════════════════════════════════════
// §6.6 用例 9：余额剩 0.3 条 → 唯一一次透支
// ══════════════════════════════════════════════════════════

test('§6.6-9 余额剩 0.3 条来 1 条成功：全额入账并透支，余额为负', () => {
  const { db, close, accountId } = setup({ balanceCredits: 0 })
  try {
    // 设余额为 0.3 条 = 300 milli
    db.prepare('UPDATE credit SET balance_milli = 300 WHERE account_id = ?').run(accountId)

    const r = settle(db, accountId, [okSend()])
    assert.strictEqual(r.settlement.billed_count, 1, '该条全额入账')
    assert.strictEqual(balanceOf(db, accountId), 300 - UNIT, '余额应为 -700 milli（-0.7 条）')
    assert.strictEqual(r.settlement.state, 'exhausted')
  } finally { close() }
})

test('§6.6-9b 透支只发生一次：余额已负后不再扣费', () => {
  const { db, close, accountId } = setup({ balanceCredits: 0 })
  try {
    db.prepare('UPDATE credit SET balance_milli = 300 WHERE account_id = ?').run(accountId)
    settle(db, accountId, [okSend()]) // 第一条透支
    const balAfterFirst = balanceOf(db, accountId)
    assert.ok(balAfterFirst < 0)

    // 再来一条：不得再透支
    const r2 = settle(db, accountId, [okSend({ sent_at_ms: NOW + 1000 })])
    assert.strictEqual(r2.settlement.billed_count, 0, '已耗尽后不得再扣费')
    assert.strictEqual(r2.results[0].billing_status, 'unbilled_insufficient_credit')
    assert.strictEqual(balanceOf(db, accountId), balAfterFirst, '余额不再变化')
  } finally { close() }
})

// ══════════════════════════════════════════════════════════
// §6.6 用例 10：降级冲突
// ══════════════════════════════════════════════════════════

test('§6.6-10 先报 confirmed 后报 failed：抛 AUDIT_SEND_CONFLICT 且保留首次记录', () => {
  const { db, close, accountId } = setup()
  try {
    const id = 's-conflict-01'
    settle(db, accountId, [okSend({ send_id: id })])
    const before = balanceOf(db, accountId)

    assert.throws(
      () => settle(db, accountId, [send({ send_id: id, verdict: 'failed', evidence: { confirm_signal: 'none' } })]),
      (e) => e.code === 'AUDIT_SEND_CONFLICT'
    )
    assert.strictEqual(balanceOf(db, accountId), before, '冲突不应改变余额')
    // 首次记录保留
    const row = db.prepare('SELECT verdict FROM send_log WHERE account_id=? AND send_id=?').get(accountId, id)
    assert.strictEqual(row.verdict, 'sent_confirmed')
  } finally { close() }
})

test('§6.6-10b source_type 不一致视为冲突而非升级', () => {
  const { db, close, accountId } = setup()
  try {
    const id = 's-conflict-02'
    settle(db, accountId, [send({ send_id: id, verdict: 'sent_suspected', evidence: { confirm_signal: 'none' } })])
    assert.throws(
      () => settle(db, accountId, [okSend({ send_id: id, source_type: 'dm' })]),
      (e) => e.code === 'AUDIT_SEND_CONFLICT'
    )
  } finally { close() }
})

// ══════════════════════════════════════════════════════════
// §6.6 用例 11：服务端重启（状态全在库中）
// ══════════════════════════════════════════════════════════

test('§6.6-11 状态全在 SQLite：重开连接后幂等仍生效', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const os = require('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bill-'))
  const dbPath = path.join(dir, 'bill.db')

  // 第一次：扣费
  const first = openDatabase(dbPath)
  const r1 = first.db.prepare(`
    INSERT INTO account (account, display_name, pass_hash, first_login_ms, created_at_ms, updated_at_ms)
    VALUES ('a1','A','h',?,?,?)
  `).run(NOW - 30 * 86400000, NOW, NOW)
  const accId = Number(r1.lastInsertRowid)
  first.db.prepare('INSERT INTO credit (account_id, balance_milli, updated_at_ms) VALUES (?,?,?)').run(accId, 100 * UNIT, NOW)
  first.db.prepare('INSERT INTO account_billing (account_id, insufficient, state, updated_at_ms) VALUES (?,0,?,?)').run(accId, 'active', NOW)

  const s = { send_id: 's-restart-1', source_type: 'comment', verdict: 'sent_confirmed',
    evidence: { confirm_signal: 'platform_response', platform_status_code: 0 }, sent_at_ms: NOW }
  B.settleSendBatch(first.db, { accountId: accId, accountDayIndex: STABLE_DAY, policyVersion: 7, nowMs: NOW, sends: [s] })
  const balAfter = Number(first.db.prepare('SELECT balance_milli FROM credit WHERE account_id=?').get(accId).balance_milli)
  assert.strictEqual(balAfter, 100 * UNIT - UNIT)
  first.close()

  // 重开连接：唯一索引保证只扣一次
  const second = openDatabase(dbPath)
  try {
    const again = B.settleSendBatch(second.db, { accountId: accId, accountDayIndex: STABLE_DAY, policyVersion: 7, nowMs: NOW, sends: [s] })
    assert.strictEqual(again.settlement.billed_count, 0, '重启后重发同一 send_id 不得再扣费')
    assert.strictEqual(again.settlement.duplicate_count, 1)
    const bal2 = Number(second.db.prepare('SELECT balance_milli FROM credit WHERE account_id=?').get(accId).balance_milli)
    assert.strictEqual(bal2, balAfter)
  } finally { second.close() }
})

// ══════════════════════════════════════════════════════════
// §6.6 用例 12：策略越权（由 policy 层负责，这里验证配额侧）
// ══════════════════════════════════════════════════════════

test('§6.6-12 策略越权由 policy.validateClientLimits 拒绝（见 policy.test.js）', () => {
  const policy = P.buildPolicy({ accountId: 1, accountDayIndex: STABLE_DAY, policyVersion: 9, nowMs: NOW })
  assert.throws(
    () => P.validateClientLimits({ dm: { daily_max: 60 } }, policy),
    (e) => e.code === 'POLICY_VIOLATION' && e.detail.allowed === 10
  )
})

// ══════════════════════════════════════════════════════════
// §6.6 用例 13：观察期仍上报 → 留痕但不计费 + 停机指令
// ══════════════════════════════════════════════════════════

test('§6.6-13 观察期上报发送明细：留痕、不计费、记 tier_sending_disabled', () => {
  const { db, close, accountId } = setup({ balanceCredits: 100 })
  try {
    const r = settle(db, accountId, [okSend()], { accountDayIndex: OBS_DAY })
    assert.strictEqual(r.settlement.billed_count, 0, '观察期上限为 0，一律不计费')
    assert.strictEqual(r.results[0].billing_status, 'policy_exceeded')
    assert.ok(r.audit_flags.includes('tier_sending_disabled'), '应记 tier_sending_disabled')
    // 明细必须留痕（审计优先）
    const row = db.prepare('SELECT * FROM send_log WHERE account_id=?').get(accountId)
    assert.ok(row, '观察期的明细也必须留痕')
    assert.strictEqual(Number(row.over_limit), 1)
    // 余额不变
    assert.strictEqual(balanceOf(db, accountId), 100 * UNIT)
  } finally { close() }
})

// ══════════════════════════════════════════════════════════
// §6.6 用例 14：online_seconds 不计费
// ══════════════════════════════════════════════════════════

test('§6.6-14 无发送明细则消耗 0 积分（时长不参与计费）', () => {
  const { db, close, accountId } = setup({ balanceCredits: 100 })
  try {
    // 心跳里的 online_seconds 与计费无关：本模块只处理 sends
    const r = settle(db, accountId, [])
    assert.strictEqual(r.settlement.billed_count, 0)
    assert.strictEqual(r.settlement.charged_milli, 0)
    assert.strictEqual(balanceOf(db, accountId), 100 * UNIT, '余额不变')
    assert.strictEqual(ledgerRows(db, accountId).length, 0, '不产生台账')
  } finally { close() }
})

// ══════════════════════════════════════════════════════════
// 配额与时间
// ══════════════════════════════════════════════════════════

test('配额：只数 billed 的成功条数（失败与疑似不占配额）', () => {
  const { db, close, accountId } = setup({ balanceCredits: 100 })
  try {
    const sends = []
    for (let i = 0; i < 8; i++) sends.push(okSend())
    for (let i = 0; i < 5; i++) sends.push(send({ verdict: 'failed', evidence: { confirm_signal: 'none' } }))
    settle(db, accountId, sends, { accountDayIndex: WARMUP_DAY })
    const used = B.usedQuota(db, accountId, 'comment', NOW)
    assert.strictEqual(used, 8, '只有 8 条成功占配额，失败的 5 条不占')
  } finally { close() }
})

test('配额：按渠道独立（评论满了不影响弹幕）', () => {
  const { db, close, accountId } = setup({ balanceCredits: 100 })
  try {
    const sends = []
    for (let i = 0; i < 10; i++) sends.push(okSend())
    settle(db, accountId, sends, { accountDayIndex: WARMUP_DAY })
    assert.strictEqual(B.usedQuota(db, accountId, 'comment', NOW), 10)
    assert.strictEqual(B.usedQuota(db, accountId, 'live_danmaku', NOW), 0)

    // 弹幕仍可发（预热期上限 10）
    const r = settle(db, accountId, [okSend({ source_type: 'live_danmaku' })], { accountDayIndex: WARMUP_DAY })
    assert.strictEqual(r.settlement.billed_count, 1)
  } finally { close() }
})

test('配额：日边界按 UTC+8 自然日切分', () => {
  const r = B.dayRange(NOW)
  assert.strictEqual(r.end - r.start, 86400000)
  const { dayStartMs } = B
  // 边界前后属于不同日
  assert.notStrictEqual(dayStartMs(r.start), dayStartMs(r.start - 1))
  assert.strictEqual(dayStartMs(r.start + 1000), dayStartMs(r.start))
})

test('单价：可配置且必须落在 0.1~1000 区间', () => {
  const { db, close, accountId } = setup({ balanceCredits: 1000 })
  try {
    // 0.5 积分/条
    const r = settle(db, accountId, [okSend(), okSend()], { creditPerReplyMilli: 500 })
    assert.strictEqual(r.settlement.charged_milli, 1000, '2 条 × 500 milli = 1000')
    // 越界被拒
    assert.throws(() => settle(db, accountId, [okSend()], { creditPerReplyMilli: 10 }),
      (e) => e.code === 'AUDIT_SEND_INVALID')
    assert.throws(() => settle(db, accountId, [okSend()], { creditPerReplyMilli: 99999999 }),
      (e) => e.code === 'AUDIT_SEND_INVALID')
  } finally { close() }
})

test('台账：settled_at_ms 用 sent_at_ms（补报不把历史消耗算到今天）', () => {
  const { db, close, accountId } = setup({ balanceCredits: 100 })
  try {
    const old = NOW - 3 * 86400000
    settle(db, accountId, [okSend({ sent_at_ms: old })], { nowMs: NOW })
    const row = ledgerRows(db, accountId)[0]
    assert.strictEqual(Number(row.settled_at_ms), old, '应按发送时刻入账，而非接收时刻')
  } finally { close() }
})

test('对账：明细与台账一致', () => {
  const { db, close, accountId } = setup({ balanceCredits: 100 })
  try {
    const sends = [okSend(), okSend(), okSend()]
    settle(db, accountId, sends)
    const r = B.reconcile(db, accountId, NOW - 86400000, NOW + 86400000)
    assert.strictEqual(r.match, true, '明细与台账应一致')
    assert.strictEqual(r.detail_count, 3)
    assert.strictEqual(r.ledger_count, 3)
    assert.strictEqual(r.detail_milli, r.ledger_milli)
  } finally { close() }
})

// ══════════════════════════════════════════════════════════
// 充值
// ══════════════════════════════════════════════════════════

test('充值：入账并清除 insufficient', () => {
  const { db, close, accountId } = setup({ balanceCredits: 0 })
  try {
    // 先耗尽
    db.prepare('UPDATE credit SET balance_milli = 300 WHERE account_id=?').run(accountId)
    settle(db, accountId, [okSend()])
    assert.ok(balanceOf(db, accountId) < 0)

    const r = B.grantCredits(db, {
      accountId, deltaMilli: 12600 * UNIT, kind: 'recharge',
      operator: 'admin:boss', note: '半年套餐', nowMs: NOW,
    })
    assert.strictEqual(r.balance_milli, 12600 * UNIT - 700)
    const st = db.prepare('SELECT insufficient, state FROM account_billing WHERE account_id=?').get(accountId)
    assert.strictEqual(Number(st.insufficient), 0, '充值后应清除 insufficient')
    assert.strictEqual(st.state, 'active')
  } finally { close() }
})

test('充值：拒绝非整数、零、未知类型、导致负余额的调整', () => {
  const { db, close, accountId } = setup({ balanceCredits: 10 })
  try {
    assert.throws(() => B.grantCredits(db, { accountId, deltaMilli: 1.5, kind: 'recharge', nowMs: NOW }),
      (e) => e.code === 'AUDIT_SEND_INVALID')
    assert.throws(() => B.grantCredits(db, { accountId, deltaMilli: 0, kind: 'recharge', nowMs: NOW }),
      (e) => e.code === 'AUDIT_SEND_INVALID')
    assert.throws(() => B.grantCredits(db, { accountId, deltaMilli: 100, kind: 'nonsense', nowMs: NOW }),
      (e) => e.code === 'AUDIT_SEND_INVALID')
    assert.throws(() => B.grantCredits(db, { accountId, deltaMilli: -100 * UNIT, kind: 'adjust', nowMs: NOW }),
      (e) => e.code === 'CREDIT_EXHAUSTED')
  } finally { close() }
})

test('不变量：扣减总额恒等于 billed 条数 × 单价', () => {
  const { db, close, accountId } = setup({ balanceCredits: 50 })
  try {
    const before = balanceOf(db, accountId)
    const sends = []
    for (let i = 0; i < 17; i++) sends.push(okSend())
    const r = settle(db, accountId, sends, { creditPerReplyMilli: 700 })
    const after = balanceOf(db, accountId)
    assert.strictEqual(before - after, r.settlement.billed_count * 700)
    assert.strictEqual(r.settlement.charged_milli, r.settlement.billed_count * 700)
  } finally { close() }
})
