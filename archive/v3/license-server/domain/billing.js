'use strict'

// license-server/domain/billing.js
//
// 计费与台账 —— **红线 2 的载体**。
//
// 契约：shared/protocol.md §6（计费算法规范），§6.6 的 14 条边界用例
//       必须一致实现，测试逐条覆盖。
//
// ⚠️ 三条不可违背的规则：
//
//   1. **只有平台确认成功的发送才计费**。`verdict=sent_confirmed` 且
//      `confirm_signal=platform_response` 且 `platform_status_code=0`，
//      三者同时成立。**DOM 判断不算**——空响应是风控拒绝。
//   2. **计费基数是条数**：N 条可计费 × unit。不是"有没有成功"的布尔。
//   3. **配额用量从 `send_log` 派生**，不维护独立计数器——计数器会与
//      事实漂移，而 `send_log` 是唯一事实来源。

const { AppError } = require('../../shared/lib/errors')
const { SOURCE_TYPES, VERDICTS } = require('../../shared/lib/protocol')
const { TIER_TABLE, tierForDayIndex, MS_PER_DAY, TZ_OFFSET_MINUTES } = require('./policy')

/** 每条成功回复的默认积分（milli）。服务端可配，存 `credit_per_reply_milli`。 */
const DEFAULT_CREDIT_PER_REPLY_MILLI = 1000

/** 允许的单价区间（protocol.md §6.1）：0.1 ~ 1000 积分，步进 0.1 */
const CREDIT_PER_REPLY_MIN_MILLI = 100
const CREDIT_PER_REPLY_MAX_MILLI = 1000000

// ═══════════════════════════════════════════════════════════
// 时间与配额
// ═══════════════════════════════════════════════════════════

/** 某个时刻所属自然日的起点（按 TZ_OFFSET_MINUTES 时区）。 */
function dayStartMs(ms, tzOffsetMinutes = TZ_OFFSET_MINUTES) {
  const tzMs = tzOffsetMinutes * 60 * 1000
  return Math.floor((ms + tzMs) / MS_PER_DAY) * MS_PER_DAY - tzMs
}

/** [dayStart, dayEnd) 区间，用于按 sent_at_ms 精确切分自然日。 */
function dayRange(ms, tzOffsetMinutes = TZ_OFFSET_MINUTES) {
  const start = dayStartMs(ms, tzOffsetMinutes)
  return { start, end: start + MS_PER_DAY }
}

/**
 * 统计某账号某渠道某自然日**已计费**的条数。
 *
 * ⚠️ 配额用量从 send_log 派生：
 *   · 只数 verdict='sent_confirmed' —— 失败、疑似、跳过都不占配额
 *   · 只数 billing_status='billed' —— 被拒的重复上报不算，避免重复计数
 *   · 按 sent_at_ms 切分自然日 —— 补报跨天时各归各日（§6.6 用例 7）
 */
function usedQuota(db, accountId, sourceType, atMs, tzOffsetMinutes = TZ_OFFSET_MINUTES) {
  const { start, end } = dayRange(atMs, tzOffsetMinutes)
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM send_log
    WHERE account_id = ? AND source_type = ?
      AND sent_at_ms >= ? AND sent_at_ms < ?
      AND verdict = 'sent_confirmed'
      AND billing_status = 'billed'
  `).get(accountId, sourceType, start, end)
  return Number(row.c)
}

/** 该账号在该时刻所处等级的某渠道日上限。 */
function dailyMaxFor(accountDayIndex, sourceType) {
  const tierDef = tierForDayIndex(accountDayIndex)
  const limits = tierDef.limits[sourceType]
  if (!limits) throw new AppError('POLICY_TIER_UNKNOWN', `未知来源类型 ${sourceType}`)
  return { max: limits.daily_max, sendingEnabled: tierDef.sending_enabled }
}

// ═══════════════════════════════════════════════════════════
// 单条判定
// ═══════════════════════════════════════════════════════════

/**
 * 判定一条发送明细的计费资格（§6.1 五条件）。
 *
 * ⚠️ 条件 ④（未被计费过）由调用方依据 SQL 唯一索引与已查记录处理，
 *    本函数不查库——保持纯函数便于测试。
 */
function evaluateBillability(send, { overLimit, billDomConfirmed = false } = {}) {
  const evidence = send.evidence || {}
  const verdict = send.verdict

  if (!VERDICTS.includes(verdict)) {
    return { billable: false, reason: 'invalid_verdict', auditFlag: 'evidence_invalid' }
  }

  // ① 平台确认
  if (verdict === 'sent_confirmed') {
    // ② 必须来自平台响应，DOM 判断不算
    if (evidence.confirm_signal !== 'platform_response') {
      return { billable: false, reason: 'dom_only', auditFlag: null }
    }
    // ③ 平台状态码必须为 0。空响应即风控拒绝，不得标记成功。
    if (Number(evidence.platform_status_code) !== 0) {
      return { billable: false, reason: 'evidence_invalid', auditFlag: 'evidence_invalid' }
    }
    // ⑤ 未超当日上限
    if (overLimit) return { billable: false, reason: 'policy_exceeded', auditFlag: null }
    return { billable: true, reason: null, auditFlag: null }
  }

  // 仅 DOM 判据确认：默认不计费（bill_dom_confirmed=false）
  if (verdict === 'sent_confirmed_dom') {
    if (billDomConfirmed) return { billable: true, reason: null, auditFlag: null }
    return { billable: false, reason: 'dom_not_billable', auditFlag: null }
  }

  // sent_suspected（含"编辑器消失即成功"这类旧判据）与 failed 一律不计费
  return { billable: false, reason: null, auditFlag: null }
}

/** 判定升级：suspected/dom/failed → confirmed 且带平台证据（§6.3）。 */
function isUpgrade(prev, next) {
  if (!prev) return false
  if (prev.verdict === 'sent_confirmed') return false
  if (next.verdict !== 'sent_confirmed') return false
  const ev = next.evidence || {}
  if (ev.confirm_signal !== 'platform_response') return false
  if (Number(ev.platform_status_code) !== 0) return false
  // source_type / sent_at_ms 必须与首次一致，否则视为冲突而非升级
  if (prev.source_type !== next.source_type) return false
  if (Number(prev.sent_at_ms) !== Number(next.sent_at_ms)) return false
  return true
}

// ═══════════════════════════════════════════════════════════
// 批量结算（§6.4 伪代码的实现）
// ═══════════════════════════════════════════════════════════

/**
 * 结算一批发送明细。
 *
 * ⚠️ 顺序要点（每一步都有契约依据）：
 *   1. **先确定整批的可计费集合，再统一结算**。计费基数是条数。
 *   2. **余额判定在循环外一次算定**，否则批内前面的扣费会影响后面的判定。
 *   3. 按 `sent_at_ms` 升序串行结算（§6.2）。
 *   4. 允许**跨零点唯一一次透支**，其后只留痕不扣费（§6.5、§6.6 用例 9）。
 *
 * @param {object} db better-sqlite-like DatabaseSync
 * @param {object} opts
 * @param {number} opts.accountId
 * @param {number} opts.accountDayIndex 账号天数索引（决定等级与上限）
 * @param {number} opts.policyVersion   实际生效的策略版本（写入明细）
 * @param {number} [opts.creditPerReplyMilli]
 * @param {boolean} [opts.billDomConfirmed=false]
 * @param {number} opts.nowMs
 * @param {Array} opts.sends
 * @returns {object} 结算结果
 */
function settleSendBatch(db, opts) {
  const {
    accountId,
    accountDayIndex,
    policyVersion,
    creditPerReplyMilli = DEFAULT_CREDIT_PER_REPLY_MILLI,
    billDomConfirmed = false,
    nowMs,
    sends,
  } = opts

  if (!Array.isArray(sends) || sends.length === 0) {
    return emptyResult(accountId, nowMs)
  }
  if (!Number.isInteger(creditPerReplyMilli) ||
      creditPerReplyMilli < CREDIT_PER_REPLY_MIN_MILLI ||
      creditPerReplyMilli > CREDIT_PER_REPLY_MAX_MILLI) {
    throw new AppError('AUDIT_SEND_INVALID', '单价超出允许区间 0.1~1000 积分/条', {
      reported_milli: creditPerReplyMilli,
    })
  }

  const unit = creditPerReplyMilli
  const auditFlags = []
  const results = []

  db.exec('BEGIN IMMEDIATE')
  try {
    const acc = loadAccountState(db, accountId)
    const ordered = sortBySentAt(sends)

    // ── 第一步：整批预判（不含余额，余额在循环外算定）──────────
    const planned = []
    for (const s of ordered) {
      planned.push(planOne(db, {
        s, acc, accountId, accountDayIndex, policyVersion, billDomConfirmed,
        tzOffsetMinutes: TZ_OFFSET_MINUTES, auditFlags,
      }))
    }

    // ── 第二步：余额与配额的**可计费条数**上限（循环外一次算定）────
    // ⚠️ 两条独立的闸门，取更小者。漏掉任何一条都是红线违规：
    //
    //   ① 余额闸门：`affordable = floor(balance/unit) + 一次透支`
    //      透支只在余额 > 0 且尚未进入 insufficient 时允许（§6.6 用例 9）。
    //
    //   ② **当日策略上限闸门**（红线 1）：契约 §6.1 的计费资格第 ⑤ 条
    //      要求"未超当日策略上限"才可计费。若只算余额不算配额，
    //      商家会被**超出日上限发送的那部分**收费——而这些发送本身
    //      就是平台风控的直接诱因，为它们收费既违反红线 1，
    //      也会在纠纷中站不住脚。
    //
    //      早期实现只做了 ①，测试"31 条明细 vs 日上限 30"时
    //      结果扣了 31 条的钱（多收 1 条）。所以这里显式算出
    //      各渠道的"当日剩余可计费条数"，并对超出的部分标记
    //      `policy_exceeded`（留痕、不计费、不占后续配额）。
    const billable = planned.filter((p) => p.action === 'settle' && p.billable)
    const canOverdraft = acc.balanceMilli > 0 && !acc.insufficient
    const balanceAffordable = Math.floor(Math.max(acc.balanceMilli, 0) / unit) + (canOverdraft ? 1 : 0)

    // 按**渠道 + 自然日**分别为每条可计费明细分配额度（按 sent_at_ms 升序先到先得）。
    // ⚠️ 键必须带自然日。只按渠道缓存会让"跨天补报"整批被算作同一天：
    //    第 1 天用满 10 条后，第 2 天的 10 条会被误判为超限全部不计费——
    //    表现为"补报的历史明细白发了"。§6.6 用例 7 专门覆盖这条。
    const quotaLeft = new Map()
    for (const p of billable) {
      const src = p.s.source_type
      const dayStart = dayStartMs(Number(p.s.sent_at_ms))
      const key = `${src}@${dayStart}`
      if (!quotaLeft.has(key)) {
        const { max } = dailyMaxFor(accountDayIndex, src)
        const used = usedQuota(db, accountId, src, Number(p.s.sent_at_ms), TZ_OFFSET_MINUTES)
        quotaLeft.set(key, Math.max(0, max - used))
      }
      const left = quotaLeft.get(key)
      if (left > 0) {
        quotaLeft.set(key, left - 1)
        p.quotaOk = true
      } else {
        p.quotaOk = false
        p.overLimit = true
        auditFlags.push('policy_daily_cap_exceeded')
      }
    }

    // ── 第三步：逐条结算（升序）──────────────────────────────
    let billedCount = 0
    let balanceMilli = acc.balanceMilli

    for (const p of planned) {
      const s = p.s

      if (p.action === 'duplicate') {
        results.push(dupResult(s, p.prev))
        continue
      }
      if (p.action === 'conflict') {
        throw new AppError('AUDIT_SEND_CONFLICT', '同一 send_id 的判定不可降级，或关键字段不一致', {
          send_id: s.send_id,
          first_verdict: p.prev ? p.prev.verdict : null,
          reported_verdict: s.verdict,
        })
      }

      let charged = 0
      const eligible = p.action === 'settle' && p.billable && p.quotaOk === true
      if (eligible) {
        if (billedCount < balanceAffordable) {
          charged = unit
          billedCount++
          balanceMilli -= unit
        }
      }

      const overLimit = p.overLimit === true
      const status = overLimit ? 'policy_exceeded'
        : charged > 0 ? 'billed'
          : eligible ? 'unbilled_insufficient_credit'
            : 'not_billable'

      if (p.upgrade) {
        // ⚠️ 判定升级（§6.3）：**更新原行**，不插入新行。
        //    理由：send_log 有 UNIQUE(account_id, send_id)，物理上不允许两行；
        //    且契约 §6.3 明确这是一次合法的判定收敛（is_final=true）。
        //    **append-only 的是 credit_ledger（台账）**，不是 send_log——
        //    "不可变账本"约束针对钱，不针对判定状态。
        //    升级时状态必然是 billed（isUpgrade 已校验平台证据），故 charged 必 > 0。
        updateSendRowForUpgrade(db, {
          accountId, sendId: s.send_id, send: s, status, charged,
          nowMs, policyVersion,
        })
      } else {
        insertSendRow(db, {
          accountId, policyVersion, send: s, status, charged, nowMs,
          overLimit, policySnapshotJson: p.policySnapshotJson,
        })
      }

      if (charged > 0) {
        // ⚠️ settled_at_ms 用 sent_at_ms 而非 nowMs。
        //    理由：看板"积分消耗（按日聚合）"按 settled_at_ms 切分，
        //    用接收时间会把补报的历史消耗全算到今天，数字失真。
        insertLedger(db, {
          accountId, deltaMilli: -charged, balanceAfterMilli: balanceMilli,
          refSendId: s.send_id, settledAtMs: Number(s.sent_at_ms),
          note: `send ${s.send_id.slice(0, 12)} ${s.source_type}`,
        })
      }

      results.push(sendResult(s, status, charged))
    }

    // ── 第四步：落余额与状态 ─────────────────────────────────
    const exhausted = balanceMilli <= 0
    const insufficient = acc.insufficient || exhausted
    persistAccountState(db, {
      accountId, balanceMilli, insufficient, nowMs,
      state: exhausted ? 'exhausted' : 'active',
    })

    // ── 自检：计费条数 × 单价 必须等于实际扣减总额 ───────────
    const expectedCharged = billedCount * unit
    const actualCharged = acc.balanceMilli - balanceMilli
    if (expectedCharged !== actualCharged) {
      throw new Error(
        `计费不变量被破坏：billedCount=${billedCount} × unit=${unit} = ${expectedCharged}，` +
        `但实际扣减 ${actualCharged}`
      )
    }

    db.exec('COMMIT')

    const unbilledInsufficient = results.filter((r) => r.billing_status === 'unbilled_insufficient_credit').length
    const policyExceeded = results.filter((r) => r.billing_status === 'policy_exceeded').length

    return {
      ok: true,
      account_id: accountId,
      results,
      settlement: {
        billed_count: billedCount,
        charged_milli: expectedCharged,
        balance_milli: balanceMilli,
        unbilled_count: results.filter((r) => String(r.billing_status).startsWith('unbilled')).length,
        over_limit_count: policyExceeded,
        duplicate_count: results.filter((r) => r.duplicate === true).length,
        state: exhausted ? 'exhausted' : 'active',
      },
      // 耗尽或越限时下发停机指令，客户端须 ≤60 秒执行
      commands: buildCommands({ exhausted, insufficient, policyExceeded }),
      audit_flags: [...new Set(auditFlags)],
      server_time_ms: nowMs,
    }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** 单条预判：幂等 / 冲突 / 计费资格 / 配额。 */
function planOne(db, ctx) {
  const { s, acc, accountId, accountDayIndex, policyVersion, billDomConfirmed, tzOffsetMinutes, auditFlags } = ctx

  const prev = db.prepare(
    'SELECT * FROM send_log WHERE account_id = ? AND send_id = ?'
  ).get(accountId, s.send_id)

  if (prev) {
    const prevVerdict = prev.verdict

    // ⚠️ 判定顺序即优先级（契约 §6.3 的三条规则 + 幂等兜底）。顺序错了会
    //    同时放过"自相矛盾的记录"和"合法的重复上报"，所以逐条说明：
    //
    //    ① **降级 → 冲突**。必须先判，否则"先 confirmed 后 failed"
    //       会被当作幂等回放放过（§6.6 用例 10）。
    //    ② **关键字段不一致 → 冲突**。source_type / sent_at_ms 不同就
    //       不是同一条发送，既不能算升级也不能算幂等（§6.3）。
    //    ③ **升级 → 计费一次**。必须在幂等之前，否则首次 suspected
    //       升级为 confirmed 时会被当重复上报而不计费（§6.6 用例 6）。
    //    ④ **已终局且非升级 → 冲突**。升级完成的条目不再接受后续判定。
    //    ⑤ **其余（同 verdict 重复上报）→ 幂等回放**，永不重复扣费。
    const rank = (v) => {
      if (v === 'sent_confirmed') return 3
      if (v === 'sent_confirmed_dom') return 2
      if (v === 'sent_suspected') return 1
      return 0 // failed
    }

    if (rank(s.verdict) < rank(prevVerdict)) {
      return { s, action: 'conflict', prev, reason: 'downgrade' }
    }

    const sameFacts = prev.source_type === s.source_type &&
      Number(prev.sent_at_ms) === Number(s.sent_at_ms)
    if (!sameFacts) {
      return { s, action: 'conflict', prev, reason: 'facts_mismatch' }
    }

    if (isUpgrade(prev, s)) {
      return {
        s, action: 'settle', prev, upgrade: true, billable: true, overLimit: false,
        policySnapshotJson: s.policy_snapshot ? JSON.stringify(s.policy_snapshot) : null,
      }
    }

    if (Number(prev.is_final) === 1 && prevVerdict !== s.verdict) {
      return { s, action: 'conflict', prev, reason: 'already_final' }
    }

    // 同 verdict 重复上报 → 幂等回放。
    // ⚠️ 即使首次未计费（如超当日上限），重复上报也仍是 duplicate——
    //    否则"越限的明细靠重发变成计费"会成为一个收费漏洞。
    return { s, action: 'duplicate', prev }
  }

  const quota = dailyMaxFor(accountDayIndex, s.source_type)
  const used = usedQuota(db, accountId, s.source_type, Number(s.sent_at_ms), tzOffsetMinutes)
  // ⚠️ 上限为 0（观察期）也算 overLimit —— §6.6 用例 13
  const overLimit = quota.max === 0 || used >= quota.max
  if (overLimit) {
    auditFlags.push(quota.max === 0 ? 'tier_sending_disabled' : 'policy_daily_cap_exceeded')
  }

  const ev = evaluateBillability(s, { overLimit, billDomConfirmed })
  if (ev.auditFlag) auditFlags.push(ev.auditFlag)

  return {
    s,
    action: 'settle',
    prev: null,
    billable: ev.billable,
    overLimit,
    policySnapshotJson: s.policy_snapshot ? JSON.stringify(s.policy_snapshot) : null,
    appliedPolicyVersion: policyVersion,
  }
}

function buildCommands({ exhausted, policyExceeded }) {
  const cmds = []
  if (exhausted) cmds.push({ type: 'pause_engine', reason: 'CREDIT_EXHAUSTED' })
  else if (policyExceeded) cmds.push({ type: 'throttle', reason: 'POLICY_DAILY_CAP_EXCEEDED' })
  return cmds
}

// ═══════════════════════════════════════════════════════════
// 持久化
// ═══════════════════════════════════════════════════════════

function loadAccountState(db, accountId) {
  const credit = db.prepare('SELECT balance_milli FROM credit WHERE account_id = ?').get(accountId)
  const billing = db.prepare('SELECT insufficient, state FROM account_billing WHERE account_id = ?').get(accountId)
  return {
    balanceMilli: credit ? Number(credit.balance_milli) : 0,
    insufficient: billing ? Number(billing.insufficient) === 1 : false,
    state: billing ? billing.state : 'active',
    hasCredit: Boolean(credit),
  }
}

function persistAccountState(db, { accountId, balanceMilli, insufficient, nowMs, state }) {
  // credit 行可能不存在（从未充值）——用 UPSERT 保证一定落盘
  db.prepare(`
    INSERT INTO credit (account_id, balance_milli, updated_at_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET balance_milli = excluded.balance_milli,
                                          updated_at_ms = excluded.updated_at_ms
  `).run(accountId, balanceMilli, nowMs)

  db.prepare(`
    INSERT INTO account_billing (account_id, insufficient, state, updated_at_ms)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET insufficient = excluded.insufficient,
                                          state = excluded.state,
                                          updated_at_ms = excluded.updated_at_ms
  `).run(accountId, insufficient ? 1 : 0, state, nowMs)
}

function insertSendRow(db, { accountId, policyVersion, send, status, charged, nowMs, overLimit, policySnapshotJson }) {
  const ev = send.evidence || {}
  db.prepare(`
    INSERT INTO send_log (
      account_id, instance_id, send_id, source_type,
      target_hash, user_key_hash, user_key_type, content_hash,
      verdict, confirm_signal, platform_endpoint, platform_status_code, failure_reason,
      billing_status, charged_milli, applied_policy_version, policy_snapshot_json,
      sent_at_ms, received_at_ms, client_version, device_id, report_id, over_limit
    ) VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?)
  `).run(
    accountId, String(send.instance_id || ''), send.send_id, send.source_type,
    send.target_hash || null, send.user_key_hash || null, send.user_key_type || null, send.content_hash || null,
    send.verdict, ev.confirm_signal || null, ev.platform_endpoint || null,
    ev.platform_status_code === undefined ? null : Number(ev.platform_status_code),
    send.failure_reason || null,
    status, charged, policyVersion, policySnapshotJson,
    Number(send.sent_at_ms), nowMs, send.client_version || null, send.device_id || null,
    send.report_id || null, overLimit ? 1 : 0
  )
}

function insertLedger(db, { accountId, deltaMilli, balanceAfterMilli, refSendId, settledAtMs, note }) {
  db.prepare(`
    INSERT INTO credit_ledger (
      account_id, kind, delta_milli, balance_after_milli, ref_send_id, operator, note, settled_at_ms
    ) VALUES (?, 'consume', ?, ?, ?, 'system', ?, ?)
  `).run(accountId, deltaMilli, balanceAfterMilli, refSendId, note || '', settledAtMs)
}

/**
 * 判定升级时更新原明细行（§6.3）。
 *
 * ⚠️ 只更新判定与计费字段，不动 send_id / source_type / sent_at_ms /
 *    内容哈希——那些是事实，改了就不是同一条发送了。
 */
function updateSendRowForUpgrade(db, { accountId, sendId, send, status, charged, nowMs, policyVersion }) {
  const ev = send.evidence || {}
  db.prepare(`
    UPDATE send_log SET
      verdict = ?, confirm_signal = ?, platform_endpoint = ?, platform_status_code = ?,
      failure_reason = NULL,
      billing_status = ?, charged_milli = ?, applied_policy_version = ?,
      received_at_ms = ?, is_final = 1
    WHERE account_id = ? AND send_id = ?
  `).run(
    send.verdict, ev.confirm_signal || null, ev.platform_endpoint || null,
    ev.platform_status_code === undefined ? null : Number(ev.platform_status_code),
    status, charged, policyVersion, nowMs, accountId, sendId
  )
}

// ═══════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════

function sortBySentAt(sends) {
  return [...sends].sort((a, b) => Number(a.sent_at_ms) - Number(b.sent_at_ms))
}

function sendResult(s, status, charged) {
  return {
    send_id: s.send_id,
    billing_status: status,
    charged_milli: charged,
    verdict: s.verdict,
    duplicate: false,
  }
}

function dupResult(s, prev) {
  return {
    send_id: s.send_id,
    billing_status: prev.billing_status,
    charged_milli: 0,
    verdict: prev.verdict,
    duplicate: true,
  }
}

function emptyResult(accountId, nowMs) {
  return {
    ok: true,
    account_id: accountId,
    results: [],
    settlement: {
      billed_count: 0, charged_milli: 0, balance_milli: null,
      unbilled_count: 0, over_limit_count: 0, duplicate_count: 0, state: 'active',
    },
    commands: [],
    audit_flags: [],
    server_time_ms: nowMs,
  }
}

/** 充值/发放积分。⚠️ 必须在事务内与台账同写。 */
function grantCredits(db, { accountId, deltaMilli, kind, operator, note, nowMs, refCodeHash }) {
  if (!Number.isInteger(deltaMilli) || deltaMilli === 0) {
    throw new AppError('AUDIT_SEND_INVALID', '积分变动必须是非零整数毫单位', { delta_milli: deltaMilli })
  }
  const allowed = ['recharge', 'grant', 'adjust', 'refund', 'redeem']
  if (!allowed.includes(kind)) {
    throw new AppError('AUDIT_SEND_INVALID', `未知的台账类型 ${kind}`, { allowed })
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    const acc = loadAccountState(db, accountId)
    const balanceMilli = acc.balanceMilli + deltaMilli
    if (balanceMilli < 0) {
      throw new AppError('CREDIT_EXHAUSTED', '调整后余额不能为负', {
        balance_milli: acc.balanceMilli, delta_milli: deltaMilli,
      })
    }

    db.prepare(`
      INSERT INTO credit_ledger (
        account_id, kind, delta_milli, balance_after_milli, ref_code_hash, operator, note, settled_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(accountId, kind, deltaMilli, balanceMilli, refCodeHash || null, operator || 'system', note || '', nowMs)

    // 入账后若余额转正，清除 insufficient 并恢复 active
    const exhausted = balanceMilli <= 0
    persistAccountState(db, {
      accountId, balanceMilli,
      insufficient: exhausted ? acc.insufficient : false,
      nowMs, state: exhausted ? 'exhausted' : 'active',
    })

    db.exec('COMMIT')
    return { ok: true, balance_milli: balanceMilli }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** 对账：明细条数/金额 与 台账 usage 条数/金额 是否一致（§6.7）。 */
function reconcile(db, accountId, fromMs, toMs) {
  const detail = db.prepare(`
    SELECT COUNT(*) AS c, COALESCE(SUM(charged_milli),0) AS m
    FROM send_log
    WHERE account_id = ? AND billing_status = 'billed'
      AND sent_at_ms >= ? AND sent_at_ms < ?
  `).get(accountId, fromMs, toMs)

  const ledger = db.prepare(`
    SELECT COUNT(*) AS c, COALESCE(-SUM(delta_milli),0) AS m
    FROM credit_ledger
    WHERE account_id = ? AND kind = 'consume'
      AND settled_at_ms >= ? AND settled_at_ms < ?
  `).get(accountId, fromMs, toMs)

  const match = Number(detail.c) === Number(ledger.c) && Number(detail.m) === Number(ledger.m)
  return {
    match,
    detail_count: Number(detail.c),
    detail_milli: Number(detail.m),
    ledger_count: Number(ledger.c),
    ledger_milli: Number(ledger.m),
  }
}

module.exports = {
  DEFAULT_CREDIT_PER_REPLY_MILLI,
  CREDIT_PER_REPLY_MIN_MILLI,
  CREDIT_PER_REPLY_MAX_MILLI,
  dayStartMs,
  dayRange,
  usedQuota,
  dailyMaxFor,
  evaluateBillability,
  isUpgrade,
  settleSendBatch,
  grantCredits,
  reconcile,
  sortBySentAt,
}
