'use strict'

// client/adapters/send-outbox.js
//
// 发送前的**先落盘**约定 —— 红线 2「send_id 必须在发送前生成并落盘」的载体。
//
// ⚠️⚠️ 这是全项目最容易被忽略、代价最高的一个约定。旧代码的问题是
//      发送成功之后才生成 ID（AGENTS.md §2.7）。后果链条是：
//
//        发送途中崩溃 / 断网 → 进程重启后**不知道刚才发过什么** →
//        任务被当成"没发过"重新执行 → **同一条评论被回复两次** →
//        商家被重复计费，而且重复回复是平台最容易识别的机器人特征。
//
//      正确顺序只有一种，不能有任何变体：
//
//        ① 生成 send_id
//        ② 把明细以 `verdict: 'pending'` 落盘（fsync 过）
//        ③ **然后**才发起平台动作
//        ④ 拿到结果后**原地更新**那条明细的 verdict / evidence
//
//      ⚠️ 第 ④ 步必须是**更新**而不是"再写一条"。写两条会让同一个
//         `send_id` 在待上报队列里出现两次，而服务端的幂等规则是
//         "同 `send_id` 重复上报按首次结果回放"——于是最终计入的是
//         **第一次那条 pending**，真正的结果被丢掉、该笔不计费。
//
// ⚠️ 为什么另开一个 `send-outbox.json` 而不是塞进 `pending-sends.json`：
//    `pending-sends.json` 是**待上报给服务端的明细**，它的每一条都必须
//    符合契约 §4.8 的字段形状（`verdict` 只能是那四个值，没有 `pending`）。
//    把未完成的发送混进去，上报时要么被服务端拒（`AUDIT_SEND_INVALID`），
//    要么被迫在拼接上报体时过滤——而"过滤"正是丢数据的经典入口。
//
//    所以拆成两份文件，职责清晰：
//      · `send-outbox.json`  —— 本机"已发出、结果未知"的账（崩溃恢复用）
//      · `pending-sends.json` —— 已定判、待上报服务端的明细（计费用）
//
// ⚠️ 内容原文（回复文案）**不进 outbox**。理由：outbox 会长期留盘
//    （崩溃恢复要靠它），而回复原文属于"页面产生的数据"，落盘即扩大
//    隐私面（红线 3）。恢复时我们只知道"这条 send_id 已发出、结果未知"，
//    这就够用了——需要的话重新从页面读取状态，而不是靠本地副本。

const crypto = require('node:crypto')

/** 本地 outbox 文件名 */
const F_OUTBOX = 'send-outbox.json'

/** outbox 中一条记录的终态。`unknown` 是最初状态，也是崩溃后保留的状态。 */
const OUTBOX_STATES = Object.freeze(['unknown', 'confirmed', 'dom_confirmed', 'suspected', 'failed'])

/** outbox 保留上限。超过就淘汰最旧的已定判记录（unknown 永不淘汰）。 */
const MAX_OUTBOX = 2000

/** 超过这个时长仍为 unknown 的记录，视为"结果永久未知"，转 suspected 后放行上报。 */
const UNKNOWN_STALE_MS = 30 * 60 * 1000

class SendOutbox {
  /**
   * @param {object} opts
   * @param {object} opts.store
   * @param {() => number} [opts.now]
   * @param {object} [opts.logger]
   */
  constructor(opts) {
    if (!opts || !opts.store) throw new Error('SendOutbox 需要 store')
    this.store = opts.store
    this.now = opts.now || (() => Date.now())
    this.logger = opts.logger || null
  }

  #log(level, msg, detail) {
    if (this.logger && typeof this.logger[level] === 'function') this.logger[level](msg, detail)
  }

  /**
   * 生成 send_id。
   *
   * ⚠️ 用 `crypto.randomBytes` 而不是 `Math.random`：send_id 是**幂等键与
   *    计费键**，碰撞会导致两笔发送被当成同一笔（少计费）或一笔被当成两笔
   *    （重复上报触发冲突告警）。`Math.random` 在进程重启后可能重复。
   */
  static newSendId() {
    return `s-${crypto.randomBytes(16).toString('hex')}`
  }

  /**
   * ① + ②：生成 ID 并落盘，返回可直接用于上报的明细骨架。
   *
   * ⚠️ 调用方拿到返回值后**必须**先完成平台动作，再调 `settle()`。
   *    中间崩溃的话，这条记录留在 outbox 里，由 `recoverUnknown()` 处理。
   *
   * @param {object} p
   * @param {string} p.sourceType
   * @param {string} p.targetHash
   * @param {string} p.userKeyHash
   * @param {string} [p.userKeyType]
   * @param {string} p.contentHash
   * @param {number} [p.appliedPolicyVersion]
   * @param {string} [p.instanceId]
   */
  begin(p) {
    if (!p || !p.sourceType || !p.targetHash || !p.contentHash) {
      throw new Error('SendOutbox.begin 需要 sourceType / targetHash / contentHash')
    }
    const sendId = SendOutbox.newSendId()
    const sentAtMs = this.now()

    const record = {
      send_id: sendId,
      source_type: p.sourceType,
      target_hash: p.targetHash,
      user_key_hash: p.userKeyHash || null,
      user_key_type: p.userKeyType || null,
      content_hash: p.contentHash,
      sent_at_ms: sentAtMs,
      state: 'unknown',
      attempt_seq: Number(p.attempt_seq || 1),
      applied_policy_version: p.applied_policy_version === undefined
        ? null : Number(p.applied_policy_version),
      instance_id: p.instance_id || null,
      created_at_ms: this.now(),
      settled_at_ms: 0,
    }

    this.store.update(F_OUTBOX, [], (list) => {
      list.push(record)
      return pruneOutbox(list)
    })

    // ⚠️ 返回的是**副本**。让调用方持有盘上对象的引用，会出现
    //    "调用方改了字段但没落盘"的静默不一致。
    return { ...record }
  }

  /**
   * ④：原地更新判定结果。
   *
   * @param {string} sendId
   * @param {object} result `{verdict, evidence, failure_reason, is_final}`
   * @returns {object} 可上报的明细（契约 §4.8 形状）
   */
  settle(sendId, result) {
    if (!sendId) throw new Error('settle 需要 sendId')
    if (!result || !result.verdict) throw new Error('settle 需要 result.verdict')

    let updated = null
    this.store.update(F_OUTBOX, [], (list) => {
      const i = list.findIndex((r) => r.send_id === sendId)
      if (i < 0) {
        // ⚠️ 找不到不能静默忽略：说明 outbox 与调用方的认知不一致
        //    （被人工清理过、或 sendId 传错了）。留痕后继续，
        //    不抛错——抛错会让一次无害的时序竞争中断整个发送链路。
        this.#log('warn', 'outbox_settle_not_found', { send_id: sendId })
        return list
      }
      list[i] = {
        ...list[i],
        state: stateOfVerdict(result.verdict),
        settled_at_ms: this.now(),
      }
      updated = list[i]
      return pruneOutbox(list)
    })

    if (!updated) {
      // 兜底：即使 outbox 里没有，也要能产出可上报的明细。
      // 上报本身有服务端幂等保护，丢一条明细的代价远大于整条链路中断。
      this.#log('warn', 'outbox_settle_synthesized', { send_id: sendId })
      return {
        send_id: sendId,
        source_type: result.source_type || 'comment',
        target_hash: result.target_hash || null,
        user_key_hash: result.user_key_hash || null,
        user_key_type: result.user_key_type || null,
        content_hash: result.content_hash || null,
        verdict: result.verdict,
        is_final: result.is_final !== false,
        evidence: result.evidence || { confirm_signal: 'none' },
        failure_reason: result.failure_reason || null,
        attempt_seq: 1,
        sent_at_ms: this.now(),
        applied_policy_version: null,
      }
    }

    return toReportable(updated, result)
  }

  /**
   * 崩溃恢复：把仍为 `unknown` 的记录交出来。
   *
   * ⚠️ 这些记录对应的发送**可能已经真的发出去了**。所以正确处理是
   *    **不要重发**，而是判成 `sent_suspected` 上报（`is_final:false`，
   *    允许之后升级为 confirmed）。重发就是重复回复。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.staleOnly] 只交出超过 `UNKNOWN_STALE_MS` 的
   * @returns {object[]} 可上报明细（`verdict: 'sent_suspected'`）
   */
  recoverUnknown(opts = {}) {
    const now = this.now()
    const cutoff = opts.staleOnly ? now - UNKNOWN_STALE_MS : Infinity
    const out = []

    this.store.update(F_OUTBOX, [], (list) => {
      for (let i = 0; i < list.length; i++) {
        const r = list[i]
        if (r.state !== 'unknown') continue
        if (Number(r.created_at_ms) > cutoff) continue
        list[i] = { ...r, state: 'suspected', settled_at_ms: now }
        out.push(toReportable(list[i], {
          verdict: 'sent_suspected',
          evidence: {
            confirm_signal: 'none',
            platform_status_code: null,
            // ⚠️ 这个标记让审计里能区分"真的没抓到响应"与"进程崩了、
            //    我们根本不知道结果"。后者在排查"为什么有几条疑似"时是关键线索。
            note: 'recovered_after_crash',
          },
          failure_reason: null,
          is_final: false,
        }))
      }
      return pruneOutbox(list)
    })

    if (out.length) {
      this.#log('warn', 'outbox_recovered_unknown', {
        count: out.length,
        hint: '这些发送的结果未知（进程中断），已按 sent_suspected 上报，'
            + '不会重发 —— 重发就是重复回复',
      })
    }
    return out
  }

  /** 当前仍为 unknown 的条数（界面显示"结果未知"用）。 */
  unknownCount() {
    return this.store.readJson(F_OUTBOX, []).filter((r) => r.state === 'unknown').length
  }

  /** 删除已上报成功的 outbox 记录（保持文件不无限增长）。 */
  drop(sendIds) {
    const set = sendIds instanceof Set ? sendIds : new Set(sendIds || [])
    if (!set.size) return 0
    let removed = 0
    this.store.update(F_OUTBOX, [], (list) => {
      return list.filter((r) => {
        const drop = set.has(r.send_id)
        if (drop) removed += 1
        return !drop
      })
    })
    return removed
  }

  /** 全部记录（排障用）。 */
  list() {
    return this.store.readJson(F_OUTBOX, [])
  }
}

// ══════════════════════════════════════════════════════════
// 纯函数
// ══════════════════════════════════════════════════════════

/** verdict → outbox 状态 */
function stateOfVerdict(verdict) {
  if (verdict === 'sent_confirmed') return 'confirmed'
  if (verdict === 'sent_confirmed_dom') return 'dom_confirmed'
  if (verdict === 'sent_suspected') return 'suspected'
  return 'failed'
}

/** outbox 记录 + 判定 → 契约 §4.8 的上报明细 */
function toReportable(record, result) {
  return {
    send_id: record.send_id,
    source_type: record.source_type,
    target_hash: record.target_hash,
    user_key_hash: record.user_key_hash,
    user_key_type: record.user_key_type,
    content_hash: record.content_hash,
    verdict: result.verdict,
    // ⚠️ `is_final` 缺省为 true。`sent_suspected` 必须显式传 false，
    //    否则服务端会把它当终局判定，后续升级为 confirmed 时被
    //    判 `AUDIT_SEND_CONFLICT`（契约 §6.3 只允许单向升级，
    //    而"已终局后再改判定"正好是冲突条件之一）。
    is_final: result.is_final === undefined ? true : Boolean(result.is_final),
    evidence: result.evidence || { confirm_signal: 'none' },
    failure_reason: result.failure_reason || null,
    attempt_seq: Number(record.attempt_seq || 1),
    sent_at_ms: Number(record.sent_at_ms),
    applied_policy_version: record.applied_policy_version === null
      ? null : Number(record.applied_policy_version),
  }
}

/**
 * 淘汰策略：**unknown 状态永不淘汰**。
 *
 * ⚠️ 这条规则很重要。unknown 记录是"可能已经发出去了但结果未知"的凭据，
 *    淘汰它等于放弃对那一笔的追踪——而它对应的可能是商家被多收的一块钱，
 *    或者一次需要向平台解释的重复发送。
 *    已定判的记录则可以淘汰：它们的价值已经转移到 pending-sends 上报队列里了。
 */
function pruneOutbox(list) {
  if (list.length <= MAX_OUTBOX) return list
  const keep = []
  const settled = []
  for (const r of list) {
    if (r.state === 'unknown') keep.push(r)
    else settled.push(r)
  }
  const room = Math.max(0, MAX_OUTBOX - keep.length)
  // settled 里保留最新的 room 条（按 settled_at_ms 升序取尾部）
  settled.sort((a, b) => Number(a.settled_at_ms || 0) - Number(b.settled_at_ms || 0))
  const kept = settled.slice(Math.max(0, settled.length - room))
  // 保持原顺序稳定：按 created_at_ms 排回来
  return [...keep, ...kept].sort((a, b) => Number(a.created_at_ms || 0) - Number(b.created_at_ms || 0))
}

module.exports = {
  SendOutbox,
  F_OUTBOX,
  OUTBOX_STATES,
  MAX_OUTBOX,
  UNKNOWN_STALE_MS,
  stateOfVerdict,
  toReportable,
  pruneOutbox,
}
