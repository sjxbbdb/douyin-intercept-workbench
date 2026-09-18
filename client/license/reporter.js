'use strict'

// client/license/reporter.js
//
// 明细上报与聚合上报 —— 契约 §4.7 §4.8 §4.9，以及 §9.3 的补报。
//
// ⚠️ 这是**计费的唯一入口**，也是红线 2 "只对平台确认成功的发送计费"
//    在客户端的配合面。客户端在本模块里**不做任何计费判定**——
//    判定权完全在服务端。客户端只负责：
//
//      1. 如实上报 `verdict` 与 `evidence`，不美化、不推断
//      2. 保证 `send_id` 幂等键的稳定性（重发必须用同一个 ID）
//      3. 按服务端返回的 `billing_status` 记账，**不自行推算余额**
//
// ⚠️ 三个高频误实现（写代码时必须对照）：
//
//   · **把 DOM 现象写成 `sent_confirmed`**。`sent_confirmed` 的语义是
//     "拿到了平台响应体且 `status_code=0`"。DOM 只能出
//     `sent_confirmed_dom`，且它**不计费**。把两者混起来会让商家以为
//     在正常计费、实际全部 `not_billable`——投诉时才发现。
//
//   · **上报后立刻删本地明细**。必须**先确认服务端已接收**（响应里有
//     该 `send_id` 的结果）再删。反了就会静默丢单：进程崩溃或响应解析
//     失败时，明细既不在本地也不在服务端，永久丢失。
//
//   · **失败批次整体重试**。若服务端返回 409 `POLICY_VIOLATION` 或
//     `REPORT_PRIVACY_VIOLATION`，重试一万次也不会成功，反而会持续
//     告警。必须区分「可重试」（网络/503）与「不可重试」（4xx 语义错误），
//     后者进隔离区并上报给运维。
//
// ⚠️ 聚合上报（`/usage/report`）**不是计费依据**（契约 §4.7）。
//    两边数字不一致时以明细为准。客户端不因此调整本地计数。

const crypto = require('node:crypto')

const { PATHS, SOURCE_TYPES, SOURCE_COUNTERS } = require('../../shared/lib/protocol')
const { AppError } = require('../../shared/lib/errors')
const { scanForPrivacyLeaks } = require('./privacy')

/** 上报相关的本地文件名（均由 host/store.js 单写者管理） */
const F_PENDING = 'pending-sends.json'
const F_QUARANTINE = 'report-quarantine.json'

/** 服务端要求的批量上限；未取到服务端 limits 时的兜底（契约 §4.5） */
const DEFAULT_SEND_BATCH_MAX = 50
const DEFAULT_AUDIT_BATCH_MAX = 500

/** 4xx 语义错误：重试无意义，进隔离区 */
const PERMANENT_CODES = new Set([
  'AUDIT_SEND_INVALID', 'AUDIT_BATCH_TOO_LARGE', 'REPORT_PRIVACY_VIOLATION',
  'REPORT_INVALID', 'REPORT_TOO_LARGE', 'AUDIT_CONFIG_INVALID',
  'POLICY_VIOLATION', 'POLICY_TIER_UNKNOWN', 'POLICY_VERSION_UNKNOWN',
  'POLICY_ACK_REQUIRED',
])

/**
 * 需要 **fail-closed 停机**（而不仅是延后重试）的错误码。
 *
 * ⚠️ 契约 §5.4 的硬要求：任何一次响应验签失败 → 记录安全事件 →
 *    **立即进入暂停态**。所以这类错误不能按"网络不好，待会儿再报"处理——
 *    那样客户端会在链路已被证明不可信的情况下继续发送，而它读到的
 *    余额、配额、策略全都可能是伪造的。
 */
const FAIL_CLOSED_CODES = new Set([
  'AUTH_SIGN_INVALID', 'AUTH_SIGN_MISSING', 'AUTH_SIGN_KEY_UNKNOWN',
])

class Reporter {
  /**
   * @param {object} opts
   * @param {object} opts.http
   * @param {object} opts.state
   * @param {object} opts.auth
   * @param {object} opts.store
   * @param {object} opts.guard
   * @param {string} opts.clientVersion
   * @param {object} [opts.logger]
   */
  constructor(opts) {
    if (!opts || !opts.http || !opts.state || !opts.auth || !opts.store) {
      throw new Error('Reporter 需要 http / state / auth / store')
    }
    this.http = opts.http
    this.state = opts.state
    this.auth = opts.auth
    this.store = opts.store
    this.guard = opts.guard || null
    this.clientVersion = opts.clientVersion || '0.0.0'
    this.logger = opts.logger || null

    /** 最近一次结算结果（供界面展示） */
    this.lastSettlement = null
    /**
     * 影子额度（离线时唯一可用的余额依据，契约 §9.3）。
     * ⚠️ **只减不增**，且只允许用服务端返回的 `balance_milli` 重建。
     *    凭空增加 = 离线期间可以无限发送。
     */
    this.localBudget = null
    /** 隔离区（不可重试的失败批次） */
    this.quarantine = this.store.readJson(F_QUARANTINE, [])
  }

  #log(level, msg, detail) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](msg, detail)
  }

  #limit(name, fallback) {
    const l = this.http.limits
    return l && Number.isFinite(Number(l[name])) ? Number(l[name]) : fallback
  }

  // ══════════════════════════════════════════════════════════
  // 影子额度
  // ══════════════════════════════════════════════════════════

  /**
   * 用服务端权威余额重建影子额度（契约 §9.3 第 ⑥ 步）。
   *
   * ⚠️ 契约 §6.5/§9.3 要求离线时额度按 `offline_budget_ratio`(0.5) 打折：
   *    离线期间余额可能已经在别的设备上被消耗，折半是为了**偏向停机**。
   *    这里只在"进入离线"时应用打折，在线时用全额——
   *    否则正常在线也会平白少一半可用量。
   */
  resetBudgetFromServer(balanceMilli, unitMilli, { offline } = {}) {
    const unit = Number(unitMilli) > 0 ? Number(unitMilli) : 1000
    const raw = Math.floor(Number(balanceMilli) / unit)
    const ratio = offline ? this.#limit('offline_budget_ratio', 0.5) : 1
    this.localBudget = Math.max(0, Math.floor(raw * ratio))
    return this.localBudget
  }

  /** 消耗一条影子额度。返回消耗后的剩余；耗尽返回 0。 */
  spendBudget(n = 1) {
    if (this.localBudget === null) return null
    this.localBudget = Math.max(0, this.localBudget - Number(n))
    return this.localBudget
  }

  /** 影子额度是否已耗尽（离线时据此 fail-closed 停机）。 */
  isBudgetExhausted() {
    return this.localBudget !== null && this.localBudget <= 0
  }

  // ══════════════════════════════════════════════════════════
  // 明细上报（计费依据）
  // ══════════════════════════════════════════════════════════

  /** 本地待上报条数（心跳要报 `pending_send_count`）。 */
  pendingCount() {
    return this.store.readJson(F_PENDING, []).length
  }

  /**
   * 取下一批待上报明细（按 `sent_at_ms` 升序）。
   *
   * ⚠️ 契约 §6.2 要求同批内按 `sent_at_ms` **升序串行结算**。
   *    排序不能放到服务端"随便"处理，因为跨自然日的明细必须按各自
   *    所属日的等级与上限核算——乱序会让服务端用错日的上限。
   */
  takeBatch(max) {
    const limit = max || Math.min(
      this.#limit('send_batch_max', DEFAULT_SEND_BATCH_MAX),
      this.#limit('audit_batch_max', DEFAULT_AUDIT_BATCH_MAX)
    )
    const all = this.store.readJson(F_PENDING, [])
    const sorted = [...all].sort((a, b) => Number(a.sent_at_ms) - Number(b.sent_at_ms))
    return sorted.slice(0, limit)
  }

  /**
   * 上报一批明细。
   *
   * @param {object} [opts]
   * @param {number} [opts.max]      本批条数上限
   * @param {boolean} [opts.force]   无明细时也发（默认不发，契约 §9.1）
   * @returns {Promise<object|null>} 无明细且非 force 时返回 null
   */
  async reportSends(opts = {}) {
    const sends = this.takeBatch(opts.max)
    if (!sends.length && !opts.force) return null
    return this.#sendBatch(sends, { allowConflictRetry: true })
  }

  async #sendBatch(sends, { allowConflictRetry }) {
    const batch = {
      batch_id: newBatchId('b'),
      account_id: this.state.accountId,
      device_id: this.state.ensureDeviceId(),
      session_id: this.state.sessionId,
      seq: this.state.nextSeq('sends'),
      protocol_version: 2,
      client_version: this.clientVersion,
      policy_snapshot: this.#policySnapshot(),
      sends,
    }

    // ⚠️ 发出**之前**做隐私扫描。服务端也会拒（`REPORT_PRIVACY_VIOLATION`），
    //    但那时数据已经离开本机了——红线 3 要求"绝不上传"，
    //    不是"上传后被拒"。
    const leaks = scanForPrivacyLeaks(batch)
    if (leaks.length) {
      this.#quarantine('privacy_leak_local', batch.batch_id, leaks)
      throw new AppError('REPORT_PRIVACY_VIOLATION',
        `上报内容含隐私字段，已在本机拦截：${leaks.join(', ')}`, { fields: leaks })
    }

    let res
    try {
      res = await this.http.request({ method: 'POST', path: PATHS.auditSends, body: batch })
    } catch (e) {
      // ── 冲突的两种服务端形态都要能处理 ────────────────────
      // 契约 §4.8 写的是逐条结果，但服务端实现（billing.js）为保持事务
      // 一致性选择**整批抛 AUDIT_SEND_CONFLICT**。两种都合法，客户端必须
      // 都能正确应对：把冲突条目摘出来，剩下的重报一次。
      // ⚠️ 否则一条历史脏数据会让**整个队列永久卡死**——
      //    后面所有正常明细都再也报不上去。
      if (e && e.code === 'AUDIT_SEND_CONFLICT' && allowConflictRetry && sends.length > 1) {
        const badId = e.detail && e.detail.send_id
        return this.#retryWithoutConflict(sends, badId, batch.batch_id)
      }
      return this.#handleReportFailure(e, batch, 'sends')
    }

    const body = res.body || {}
    const results = Array.isArray(body.results) ? body.results : []

    // ── ① 逐条确认后再删本地明细 ──────────────────────────
    // ⚠️ 服务端 `results[]` 里没有 `accepted` 字段（只有 billing_status），
    //    而契约 §4.8 的示例里有。两种形态都要认：有 `accepted` 时按它判，
    //    没有时"出现在 results 里"即视为已受理——因为它带回了服务端的
    //    判定结果，说明服务端已经处理过这一条。
    const acceptedIds = new Set()
    for (const r of results) {
      if (!r || !r.send_id) continue
      if (r.accepted === false) continue
      acceptedIds.add(r.send_id)
    }

    // ⚠️ 关键：**只删服务端明确受理的**。未被 results 覆盖的条目留在本地
    //    待重报。若整批删除，遇到服务端只处理了前 N 条（例如中途异常）
    //    就会永久丢失后面的明细。
    this.#removePending(acceptedIds)

    // ── ② 结算结果 ────────────────────────────────────────
    const settlement = body.settlement || null
    this.lastSettlement = settlement

    if (settlement && Number.isFinite(Number(settlement.balance_milli))) {
      // ⚠️ 服务端余额是**唯一权威**。这里重建影子额度，而不是自己加减。
      //    客户端自行加减会在漏报/补报/幂等命中时累积误差，
      //    最终表现为"本地以为还有额度、服务端已经欠费"。
      this.state.setBalanceMilli(Number(settlement.balance_milli))
      this.resetBudgetFromServer(
        Number(settlement.balance_milli),
        this.state.credit ? this.state.credit.credit_per_reply_milli : 1000
      )
    }

    this.#log('info', 'sends_reported', {
      batch_id: batch.batch_id,
      count: sends.length,
      accepted: acceptedIds.size,
      billed_count: settlement ? settlement.billed_count : null,
      charged_milli: settlement ? settlement.charged_milli : null,
      state: settlement ? settlement.state : null,
    })

    return {
      body,
      results,
      settlement,
      accepted: acceptedIds.size,
      conflicts: [],
      commands: Array.isArray(body.commands) ? body.commands : [],
      // 结算后余额 ≤ 0 → 上层必须 ≤60 秒停机（契约 §4.8）
      exhausted: Boolean(settlement && settlement.state === 'exhausted'),
    }
  }

  /**
   * 整批冲突时：摘出冲突条目重报其余。
   *
   * ⚠️ 为什么必须这么做：服务端为保持事务一致性会**整批抛错**，
   *    而一条历史脏数据（例如本地判定与首次上报不一致）就会让
   *    整个待上报队列永久卡死——后面所有正常明细都再也送不上去，
   *    商家看到的是"发送在跑、积分不扣、看板不动"。
   *
   * 摘除是**保守**的：只摘服务端点名的那一条，其余原样重报。
   * 若没点名（`detail.send_id` 缺失），则摘出**该批第一条**——
   * 服务端按 `sent_at_ms` 升序结算，第一条就是它遇到的冲突项。
   */
  async #retryWithoutConflict(sends, badSendId, parentBatchId) {
    const ordered = [...sends].sort((a, b) => Number(a.sent_at_ms) - Number(b.sent_at_ms))
    const victim = badSendId
      ? ordered.find((s) => s.send_id === badSendId)
      : ordered[0]

    if (!victim) {
      // 服务端点名了一个不在本批里的 send_id —— 说明双方对"这一批"
      // 的理解已经不一致，重报没有意义。隔离并留痕。
      this.#quarantine('AUDIT_SEND_CONFLICT', parentBatchId, { reported_send_id: badSendId || null })
      this.#log('error', 'conflict_send_not_in_batch', { batch_id: parentBatchId, send_id: badSendId })
      return {
        body: null, results: [], settlement: null, accepted: 0, conflicts: [badSendId].filter(Boolean),
        commands: [], error: 'AUDIT_SEND_CONFLICT', quarantined: true,
      }
    }

    // ⚠️ 隔离但**不删除**：这条明细是计费与举证的凭据（红线 3 双写），
    //    而且冲突往往意味着"本地记录与服务端首次记录不一致"，
    //    保留它才能人工比对出到底哪边错了。
    this.#quarantine('AUDIT_SEND_CONFLICT', parentBatchId, {
      send_id: victim.send_id, verdict: victim.verdict, sent_at_ms: victim.sent_at_ms,
    })
    this.#removePending(new Set([victim.send_id]))

    const rest = sends.filter((s) => s.send_id !== victim.send_id)
    this.#log('warn', 'conflict_isolated', {
      batch_id: parentBatchId, isolated: victim.send_id, retrying: rest.length,
    })

    if (!rest.length) {
      return {
        body: null, results: [], settlement: null, accepted: 0,
        conflicts: [victim.send_id], commands: [], error: 'AUDIT_SEND_CONFLICT', quarantined: true,
      }
    }

    const retried = await this.#sendBatch(rest, { allowConflictRetry: false })
    retried.conflicts = [victim.send_id, ...(retried.conflicts || [])]
    return retried
  }

  /** 从本地待上报列表移除已被服务端接收的条目（读-改-写）。 */
  #removePending(sendIds) {
    if (!sendIds || sendIds.size === 0) return 0
    let removed = 0
    this.store.update(F_PENDING, [], (list) => {
      const next = list.filter((s) => {
        const drop = sendIds.has(s.send_id)
        if (drop) removed += 1
        return !drop
      })
      return next
    })
    return removed
  }

  /**
   * 处理上报失败：区分「可重试」/「不可重试」/「必须停机」。
   *
   * ⚠️ 三类后果完全不同，混为一谈会出大问题：
   *    · 可重试（网络/503）：延后补报，明细留本地
   *    · 不可重试（语义 4xx）：进隔离区，继续重试没有意义
   *    · **必须停机（验签失败）**：契约 §5.4 要求立即暂停发送。
   *      若把它也当成"延后补报"，客户端会在链路已被证明不可信的情况下
   *      继续发送，而且它读到的余额/配额/策略都可能是伪造的。
   *
   * ⚠️ 明细**一律留在本地**。即使判定为不可重试也只移入隔离区，
   *    绝不删除——它是计费与举证的唯一凭据（红线 3 的双写要求）。
   */
  #handleReportFailure(e, batch, kind) {
    const code = e && e.code
    const failClosed = FAIL_CLOSED_CODES.has(code)
    const permanent = PERMANENT_CODES.has(code)

    const base = {
      body: null, results: [], settlement: null, accepted: 0, conflicts: [],
      commands: [], error: code, failClosed,
    }

    if (permanent) {
      this.#quarantine(code, batch.batch_id, e && e.detail ? e.detail : null)
      this.#log('error', 'report_rejected', {
        kind, batch_id: batch.batch_id, code,
        hint: '该批次被服务端语义性拒绝，已移入隔离区；继续重试不会成功',
      })
      return { ...base, quarantined: true }
    }

    this.#log(failClosed ? 'error' : 'warn', failClosed ? 'report_fail_closed' : 'report_deferred', {
      kind, batch_id: batch.batch_id, code,
      pending: batch.sends ? batch.sends.length : null,
      hint: failClosed
        ? '响应验签失败／密钥不可用：链路不可信，必须立即停止发送（契约 §5.4）'
        : '网络/服务端暂时不可用，明细留在本地待补报',
    })
    return { ...base, deferred: !failClosed }
  }

  #quarantine(code, batchId, detail) {
    this.quarantine = this.store.update(F_QUARANTINE, [], (list) => {
      list.push({ code, batch_id: batchId, detail, at_ms: Date.now() })
      // 隔离区只保留最近 200 条，避免无限增长；丢弃最旧的。
      return list.slice(-200)
    })
  }

  // ══════════════════════════════════════════════════════════
  // 聚合上报（看板用，非计费依据）
  // ══════════════════════════════════════════════════════════

  /**
   * 上报一个统计窗口的聚合计数。
   *
   * @param {object} window {start_ms, end_ms, sources, failure_reasons, unique_users_total}
   * @returns {Promise<object|undefined>}
   */
  async reportUsage(window) {
    const clean = normalizeWindow(window)
    const report = {
      report_id: newBatchId('r'),
      account_id: this.state.accountId,
      device_id: this.state.ensureDeviceId(),
      session_id: this.state.sessionId,
      seq: this.state.nextSeq('usage'),
      window_start_ms: clean.start_ms,
      window_end_ms: clean.end_ms,
      sources: clean.sources,
      failure_reasons: clean.failure_reasons,
      unique_users_total: clean.unique_users_total,
      policy_snapshot: this.#policySnapshot(),
      client_version: this.clientVersion,
      protocol_version: 2,
    }

    const leaks = scanForPrivacyLeaks(report)
    if (leaks.length) {
      this.#quarantine('privacy_leak_local', report.report_id, leaks)
      throw new AppError('REPORT_PRIVACY_VIOLATION',
        `聚合上报含隐私字段，已在本机拦截：${leaks.join(', ')}`, { fields: leaks })
    }

    try {
      const res = await this.http.request({ method: 'POST', path: PATHS.usageReport, body: report })
      const body = res.body || {}
      // ⚠️ 对账不一致时**不改本地计数**。契约 §4.7：以明细为准，
      //    聚合只是看板口径。改本地计数会让"到底发了多少条"失去唯一答案。
      if (body.reconciliation && body.reconciliation.match === false) {
        this.#log('warn', 'reconciliation_mismatch', body.reconciliation)
      }
      return body
    } catch (e) {
      this.#handleReportFailure(e, report, 'usage')
      return undefined
    }
  }

  // ══════════════════════════════════════════════════════════
  // 配置变更审计（红线 3 的原始证据）
  // ══════════════════════════════════════════════════════════

  /**
   * 上报配置变更。
   *
   * ⚠️ `applied=false` 的行才是关键证据：它证明"用户主动调高过、
   *    系统拒绝过"（契约 §4.9）。所以**被拒绝的变更也必须上报**，
   *    而不是"反正没生效就不报了"。
   *
   * @param {object[]} changes
   */
  async reportConfigChanges(changes) {
    if (!Array.isArray(changes) || changes.length === 0) return null

    const batch = {
      batch_id: newBatchId('c'),
      account_id: this.state.accountId,
      device_id: this.state.ensureDeviceId(),
      session_id: this.state.sessionId,
      seq: this.state.nextSeq('config_audit'),
      protocol_version: 2,
      changes: changes.map(normalizeChange),
    }

    const leaks = scanForPrivacyLeaks(batch)
    if (leaks.length) {
      throw new AppError('REPORT_PRIVACY_VIOLATION',
        `配置变更审计含隐私字段，已在本机拦截：${leaks.join(', ')}`, { fields: leaks })
    }

    try {
      const res = await this.http.request({ method: 'POST', path: PATHS.auditConfigChanges, body: batch })
      return res.body || {}
    } catch (e) {
      this.#handleReportFailure(e, batch, 'config_audit')
      return undefined
    }
  }

  // ══════════════════════════════════════════════════════════
  // 内部
  // ══════════════════════════════════════════════════════════

  /**
   * `policy_snapshot`：**实际生效**的策略快照（红线 3）。
   *
   * ⚠️ 取护栏的生效值，不取服务端下发的原值。两者可能不同——
   *    商家可以在客户端调低。若上报原值，就丢失了"实际生效多少"，
   *    而这正是纠纷时要回答的问题。
   */
  #policySnapshot() {
    const p = this.state.policy
    const ws = this.guard ? this.guard.snapshot() : null
    const applied = {}
    if (ws) {
      for (const src of SOURCE_TYPES) {
        const l = ws.limits[src] || {}
        applied[src] = {
          daily_max: Number(l.daily_max || 0),
          min_interval_ms: Number(l.min_interval_ms || 0),
        }
      }
    }
    return {
      policy_version: p ? Number(p.policy_version) : null,
      policy_hash: p ? (p.policy_hash || null) : null,
      applied_limits: applied,
      account_tier: p ? p.account_tier : null,
      account_day_index: p ? Number(p.account_day_index) : null,
      captured_at_ms: this.http.nowTs(),
    }
  }
}

// ══════════════════════════════════════════════════════════
// 纯函数
// ══════════════════════════════════════════════════════════

/** 生成幂等键：`<prefix>-<32hex>`（契约 §4.7/§4.8 的 ID 形态）。 */
function newBatchId(prefix) {
  return `${prefix}-${crypto.randomBytes(16).toString('hex')}`
}

/**
 * 归一化聚合窗口。
 *
 * ⚠️ `sources` 必须补齐**全部**三来源与**全部**计数字段（缺项补 0）。
 *    契约 §4.7 的对账按 `sources.*.sent_confirmed` 求和比对明细，
 *    少一个来源就会产生永久性的 `aggregate_mismatch`，
 *    而运营会把它当成"客户端有问题"来排查。
 */
function normalizeWindow(w) {
  if (!w || !Number.isFinite(Number(w.start_ms)) || !Number.isFinite(Number(w.end_ms))) {
    throw new Error('reportUsage 需要 window.start_ms 与 window.end_ms')
  }
  if (Number(w.end_ms) <= Number(w.start_ms)) {
    throw new Error('reportUsage 的 window_end_ms 必须大于 window_start_ms')
  }

  const sources = {}
  for (const src of SOURCE_TYPES) {
    const given = (w.sources && w.sources[src]) || {}
    const out = {}
    for (const f of SOURCE_COUNTERS) out[f] = Number(given[f] || 0)
    sources[src] = out
  }

  return {
    start_ms: Number(w.start_ms),
    end_ms: Number(w.end_ms),
    sources,
    failure_reasons: w.failure_reasons && typeof w.failure_reasons === 'object'
      ? { ...w.failure_reasons } : {},
    unique_users_total: Number(w.unique_users_total || 0),
  }
}

/**
 * 归一化一条配置变更记录（契约 §4.9）。
 *
 * ⚠️ `old_value`/`new_value` 强制转成字符串。契约要求字符串形态，
 *    传数字会被服务端按未知形态处理。同时**禁止**正文与隐私数据——
 *    这里用白名单式的 `field_key` 校验兜底。
 */
function normalizeChange(c) {
  if (!c || !c.field_key) throw new AppError('AUDIT_CONFIG_INVALID', '配置变更缺少 field_key')
  if (!ALLOWED_FIELD_KEYS.test(c.field_key)) {
    throw new AppError('AUDIT_CONFIG_INVALID',
      `field_key 不在白名单内：${c.field_key}`, { field_key: c.field_key })
  }
  if (c.applied === false && !c.reject_code) {
    throw new AppError('AUDIT_CONFIG_INVALID',
      `applied=false 时必须给出 reject_code（field_key=${c.field_key}）`)
  }
  return {
    change_id: c.change_id || `ch-${crypto.randomBytes(8).toString('hex')}`,
    changed_at_ms: Number(c.changed_at_ms || Date.now()),
    source: c.source || 'user',
    actor: c.actor || 'local_user',
    field_key: c.field_key,
    old_value: c.old_value === undefined || c.old_value === null ? null : String(c.old_value),
    new_value: c.new_value === undefined || c.new_value === null ? null : String(c.new_value),
    applied: c.applied !== false,
    reject_code: c.reject_code || null,
    policy_version: c.policy_version === undefined ? null : Number(c.policy_version),
  }
}

/**
 * 允许上报的配置字段路径。
 *
 * ⚠️ 白名单而非黑名单：黑名单永远会漏（今天想到 comment 原文，
 *    明天可能冒出 `reply_draft`）。白名单漏了只会少记一条审计，
 *    黑名单漏了会泄露隐私——两种失败的代价不对称。
 */
const ALLOWED_FIELD_KEYS = /^(limits\.(comment|live_danmaku|dm)\.(daily_max|min_interval_ms|content_similarity_max)|active_hours|emergency_stop|engine_state|reply_strategy|reply_style|enabled_sources|template_id|quiet_hours)$/

module.exports = {
  Reporter,
  F_PENDING,
  F_QUARANTINE,
  DEFAULT_SEND_BATCH_MAX,
  DEFAULT_AUDIT_BATCH_MAX,
  PERMANENT_CODES,
  FAIL_CLOSED_CODES,
  ALLOWED_FIELD_KEYS,
  newBatchId,
  normalizeWindow,
  normalizeChange,
}
