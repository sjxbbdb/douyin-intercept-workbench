'use strict'

// client/host/queue.js
//
// 任务队列 —— 采集到的线索、待回复的评论/弹幕/私信都排在这里。
//
// ⚠️ 本模块存在的唯一理由是修掉旧代码最贵的一个 bug（docs/需求规格.md D-7）：
//
//    旧 `reply_worker.js` 在循环开头把整个队列读进内存，循环结束后
//    **用这个陈旧对象全量覆写文件**。期间任何新增任务都被丢掉。
//    表现是"采集到的评论偶尔不回复"，而且**无法复现**——
//    因为丢不丢取决于循环期间有没有新任务进来。
//
//    根治办法有三条，缺一不可：
//      ① **所有修改走 store.update(name, fallback, mutator)**——
//         mutator 拿到的是刚从盘上读出的最新值，不是调用方持有的旧对象；
//      ② **取出/归还任务必须原子化**：`take()` 一次只交付一条并立即落盘，
//         不允许"内存里拿着一批，跑完再写回"；
//      ③ **进程重启后把 in-flight 任务放回待办**，而不是留在 `processing`
//         永不复位——否则崩一次就永久少一批任务。
//
// ⚠️ 状态机（终态只有 done / skipped / failed）：
//
//     queued ──take──► processing ──ok──► done
//                        │  │
//                        │  ├──skip──► skipped   （命中但不回复，比如已被回复过）
//                        │  └──fail──► failed    （重试用尽）
//                        └──requeue──► queued    （标签页丢失等**可重试**故障）
//
// ⚠️ `requeue` 与 `fail` 的区别极其重要：
//    计划文档要求的"自愈率 ≥95%"完全依赖这一条。标签页被回收、CDP 掉线
//    这类故障**不是任务的错**，判成 failed 会让任务永久消失；
//    判成 requeue 才能真正重试。判据是错误码是否在白名单里
//    （见 `RETRYABLE_CODES`），由调度器传入，队列只做记录。

const { SOURCE_TYPES } = require('../../shared/lib/protocol')

/** 队列文件名（与 store.js 的 SCHEMA_VERSIONS 对齐） */
const F_QUEUE = 'queue.json'
const F_REPLIED = 'replied-history.json'
const F_LEADS = 'leads.json'

/** 队列容量上限。超过就拒绝新增（而不是静默丢弃最旧的）。
 *
 * ⚠️ 为什么拒绝而不是淘汰：队列里每一条都对应"一个真实用户留下的评论"。
 *    静默淘汰最旧的 = 悄悄不回复早期用户，且事后无法证明丢过。
 *    拒绝新增则会让调度器立刻看到"队列满了"，从而暴露问题。
 */
const MAX_QUEUE_SIZE = 5000

/** 去重历史上限。只保留近期，避免无限增长。 */
const MAX_REPLIED_HISTORY = 20000

/** 单条任务的最大尝试次数；超过进 failed。 */
const MAX_ATTEMPTS = 3

/** 终态 */
const TERMINAL_STATES = Object.freeze(['done', 'skipped', 'failed'])

/** 任务类型（与来源渠道一一对应，另有只用于采样的 collect） */
const TASK_KINDS = Object.freeze(['collect', 'reply_comment', 'reply_danmaku', 'send_dm'])

class Queue {
  /**
   * @param {object} opts
   * @param {object} opts.store 客户端 Store（唯一写盘者）
   * @param {() => number} [opts.now]
   */
  constructor(opts) {
    if (!opts || !opts.store) throw new Error('Queue 需要 store')
    this.store = opts.store
    this.now = opts.now || (() => Date.now())
  }

  // ══════════════════════════════════════════════════════════
  // 入队
  // ══════════════════════════════════════════════════════════

  /**
   * 新增一条任务。
   *
   * ⚠️ 幂等键是 `dedupKey`（由调用方用隐私哈希算出）：
   *    同一评论被采集两次只能入队一次——否则会被回复两次，
   *    而"重复回复同一用户"是最容易被平台识别为机器人的行为之一。
   *
   * @returns {{added:boolean, reason?:string, task?:object}}
   */
  add(task) {
    const t = normalizeTask(task, this.now())
    let result = { added: false }

    this.store.update(F_QUEUE, [], (list) => {
      if (list.length >= MAX_QUEUE_SIZE) {
        // ⚠️ 拒绝而不是淘汰。见 MAX_QUEUE_SIZE 的说明。
        result = { added: false, reason: 'queue_full', size: list.length }
        return list
      }
      const dup = list.some((x) => x.dedupKey === t.dedupKey && !TERMINAL_STATES.includes(x.state))
      if (dup) {
        result = { added: false, reason: 'duplicate' }
        return list
      }
      // 已处理过的（终态里出现过）也不重复入队
      if (this.hasReplied(t.dedupKey)) {
        result = { added: false, reason: 'already_replied' }
        return list
      }
      list.push(t)
      result = { added: true, task: t }
      return list
    })

    return result
  }

  /** 批量入队，返回逐条结果。 */
  addMany(tasks) {
    return tasks.map((t) => this.add(t))
  }

  // ══════════════════════════════════════════════════════════
  // 取出与归还
  // ══════════════════════════════════════════════════════════

  /**
   * 取出一条可执行任务并**立即落盘**标记为 processing。
   *
   * ⚠️ 一次只取一条。这是刻意限制：批量取出就必须批量写回，
   *    而批量写回正是旧代码丢任务的形态。
   *
   * @param {object} [opts]
   * @param {string} [opts.kind]       只取某类任务
   * @param {string} [opts.sourceType] 只取某渠道（comment/live_danmaku/dm）
   */
  take(opts = {}) {
    let taken = null
    this.store.update(F_QUEUE, [], (list) => {
      // ⚠️ 排序规则要稳定：先按入队时间（FIFO），保证早期评论先被回复。
      //    若按"优先级"随机取，早期评论可能永远排不上，商家会觉得"漏回复"。
      const candidates = list
        .filter((x) => x.state === 'queued')
        .filter((x) => (opts.kind ? x.kind === opts.kind : true))
        .filter((x) => (opts.sourceType ? x.sourceType === opts.sourceType : true))
        .sort((a, b) => a.enqueuedAtMs - b.enqueuedAtMs)

      const idx = list.findIndex((x) => candidates.length && x.id === candidates[0].id)
      if (idx < 0) return list

      list[idx] = {
        ...list[idx],
        state: 'processing',
        attempts: list[idx].attempts + 1,
        takenAtMs: this.now(),
      }
      taken = list[idx]
      return list
    })
    return taken
  }

  /**
   * 把任务放回待办（标签页丢失、CDP 掉线等**可重试**故障）。
   *
   * ⚠️ 这是"自愈率 ≥95%"的关键路径。attempts 已经递增过，所以
   *    放回后仍受 MAX_ATTEMPTS 约束——无限重试同样是缺陷
   *    （会让一条坏任务永久占住队头）。
   */
  requeue(taskId, reason) {
    return this.#transition(taskId, (t) => {
      if (t.attempts >= MAX_ATTEMPTS) {
        return { ...t, state: 'failed', failureReason: reason || 'retry_exhausted', finishedAtMs: this.now() }
      }
      // ⚠️ 必须用 `push` 语义把入队时间保留原值，否则重试的任务
      //    会被排到队尾，饥饿的早期任务永远轮不到。
      return { ...t, state: 'queued', lastRetryReason: reason || null, requeuedAtMs: this.now() }
    })
  }

  /** 标记完成。 */
  done(taskId, detail) {
    return this.#transition(taskId, (t) => ({
      ...t, state: 'done', finishedAtMs: this.now(), result: detail || null,
    }))
  }

  /** 标记跳过（命中但不回复，例如已回复过该用户）。 */
  skip(taskId, reason) {
    return this.#transition(taskId, (t) => ({
      ...t, state: 'skipped', skipReason: reason || null, finishedAtMs: this.now(),
    }))
  }

  /** 标记失败（重试用尽或语义性错误）。 */
  fail(taskId, reason, detail) {
    return this.#transition(taskId, (t) => ({
      ...t, state: 'failed', failureReason: reason || 'unknown',
      failureDetail: detail || null, finishedAtMs: this.now(),
    }))
  }

  /** 通用状态转换（读-改-写，只动目标那一条）。 */
  #transition(taskId, fn) {
    let out = null
    this.store.update(F_QUEUE, [], (list) => {
      const i = list.findIndex((x) => x.id === taskId)
      if (i < 0) {
        // ⚠️ 找不到不等于可以静默忽略：说明队列与调用方的认知不一致
        //    （可能被人工清理过）。记录下来供排障，但不抛错——
        //    抛错会让一次无害的时序竞争中断整个调度循环。
        out = { ok: false, reason: 'task_not_found', taskId }
        return list
      }
      list[i] = fn(list[i])
      out = { ok: true, task: list[i] }
      return list
    })
    return out
  }

  // ══════════════════════════════════════════════════════════
  // 崩溃恢复
  // ══════════════════════════════════════════════════════════

  /**
   * 进程启动时调用：把遗留的 `processing` 任务放回 `queued`。
   *
   * ⚠️ 不做这一步的后果：进程在发送途中崩溃/被杀死，那条任务永远停在
   *    `processing`，既不会被重试也不会被统计——表现为"采集到了但没回复，
   *    日志里也查不到"。而且只有崩溃后才会出现，最难复现。
   *
   * @returns {{recovered:number, total:number}}
   */
  recoverInFlight() {
    let recovered = 0
    this.store.update(F_QUEUE, [], (list) => {
      for (let i = 0; i < list.length; i++) {
        if (list[i].state !== 'processing') continue
        recovered += 1
        if (list[i].attempts >= MAX_ATTEMPTS) {
          list[i] = {
            ...list[i], state: 'failed',
            failureReason: 'interrupted_after_max_attempts',
            finishedAtMs: this.now(),
          }
        } else {
          list[i] = { ...list[i], state: 'queued', lastRetryReason: 'interrupted' }
        }
      }
      return list
    })
    return { recovered, total: this.size() }
  }

  // ══════════════════════════════════════════════════════════
  // 去重历史（"同一用户 N 小时内只回复一次"依赖它）
  // ══════════════════════════════════════════════════════════

  /**
   * 记录一次已回复。
   *
   * ⚠️ 必须落盘。旧代码的去重历史写盘失败被空 catch 吞掉，
   *    导致同一评论被重复回复且无人发现（AGENTS.md §2.8 的实例）。
   *    本方法**不吞异常**——写不进去就让调用方看到。
   */
  markReplied({ dedupKey, userKeyHash, sourceType, atMs }) {
    if (!dedupKey) throw new Error('markReplied 需要 dedupKey')
    const entry = {
      dedupKey,
      userKeyHash: userKeyHash || null,
      sourceType: sourceType || null,
      atMs: atMs === undefined ? this.now() : atMs,
    }
    this.store.update(F_REPLIED, [], (list) => {
      list.push(entry)
      return list.length > MAX_REPLIED_HISTORY ? list.slice(-MAX_REPLIED_HISTORY) : list
    })
    return entry
  }

  /** 该去重键是否已回复过。 */
  hasReplied(dedupKey) {
    return this.store.readJson(F_REPLIED, []).some((e) => e.dedupKey === dedupKey)
  }

  /**
   * 该用户是否在窗口内已被回复过。
   * @param {string} userKeyHash 用户标识哈希（**不是** sec_uid 原文，红线 3）
   * @param {number} [windowMs] 默认 24 小时（验收标准 12）
   */
  userRepliedWithin(userKeyHash, windowMs = 86400000, atMs) {
    if (!userKeyHash) return false
    const now = atMs === undefined ? this.now() : atMs
    return this.store.readJson(F_REPLIED, []).some(
      (e) => e.userKeyHash === userKeyHash && now - Number(e.atMs) < windowMs
    )
  }

  // ══════════════════════════════════════════════════════════
  // 查询（界面用）
  // ══════════════════════════════════════════════════════════

  size() {
    return this.store.readJson(F_QUEUE, []).length
  }

  /** 各状态的条数。界面顶部的"待处理 / 已完成 / 失败"就靠它。 */
  stats() {
    const list = this.store.readJson(F_QUEUE, [])
    const out = { total: list.length, queued: 0, processing: 0, done: 0, skipped: 0, failed: 0, bySource: {} }
    for (const t of list) {
      if (out[t.state] !== undefined) out[t.state] += 1
      const s = t.sourceType || 'unknown'
      out.bySource[s] = (out.bySource[s] || 0) + 1
    }
    return out
  }

  /** 列出任务（界面用）。默认只返回未完成的。 */
  list({ state, limit = 200 } = {}) {
    const all = this.store.readJson(F_QUEUE, [])
    const filtered = state ? all.filter((t) => t.state === state) : all
    return filtered.slice(-limit)
  }

  /**
   * 清理已完成任务。
   *
   * ⚠️ 只清理 **done / skipped**，且只清理早于 `beforeMs` 的。
   *    `failed` **一律保留**——它是排障与举证的依据（为什么这条没回复？
   *    是不是被风控拒了？），清掉就再也查不出原因了。
   *    这个"不清理 failed"不是可配置项，是写死的行为。
   */
  prune({ beforeMs } = {}) {
    const cutoff = beforeMs === undefined ? this.now() - 7 * 86400000 : beforeMs
    let removed = 0
    this.store.update(F_QUEUE, [], (list) => {
      const next = list.filter((t) => {
        const terminal = t.state === 'done' || t.state === 'skipped'
        const finished = Number(t.finishedAtMs || 0)
        const drop = terminal && finished > 0 && finished < cutoff
        if (drop) removed += 1
        return !drop
      })
      return next
    })
    return { removed }
  }

  /** 待上报的发送明细条数（心跳要报 `pending_send_count`）。 */
  pendingSendCount() {
    return this.store.readJson('pending-sends.json', []).length
  }

  // ══════════════════════════════════════════════════════════
  // 线索
  // ══════════════════════════════════════════════════════════

  /**
   * 记录一条线索（意向客户）。
   *
   * ⚠️ 只存哈希，不存 `sec_uid` 原文与昵称（红线 3）。
   *    需要展示"是谁"的时候，数据本来就在商家自己的 Chrome 页面里。
   */
  addLead({ userKeyHash, sourceType, hitKeywordHash, atMs }) {
    if (!userKeyHash) throw new Error('addLead 需要 userKeyHash')
    let added = false
    this.store.update(F_LEADS, [], (list) => {
      if (list.some((l) => l.userKeyHash === userKeyHash)) return list
      list.push({
        userKeyHash,
        sourceType: sourceType || null,
        hitKeywordHash: hitKeywordHash || null,
        atMs: atMs === undefined ? this.now() : atMs,
      })
      added = true
      return list
    })
    return { added }
  }

  leadCount() {
    return this.store.readJson(F_LEADS, []).length
  }
}

// ══════════════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════════════

let idCounter = 0

/**
 * 生成任务 ID。
 *
 * ⚠️ 用"时间戳 + 计数器 + 随机"而不是随机 uuid：任务 ID 会出现在日志里，
 *    可排序的 ID 让"按时间翻日志"成为可能。计数器保证同毫秒内不重复。
 */
function makeTaskId(nowMs) {
  idCounter = (idCounter + 1) % 1000000
  return `t-${nowMs.toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function normalizeTask(task, nowMs) {
  if (!task || typeof task !== 'object') throw new Error('任务必须是对象')
  if (!task.kind || !TASK_KINDS.includes(task.kind)) {
    throw new Error(`未知任务类型 ${task.kind}（允许：${TASK_KINDS.join('/')}）`)
  }
  if (!task.dedupKey) {
    // ⚠️ 没有去重键就不允许入队：那等于放弃了"不重复回复"的保证。
    throw new Error('任务缺少 dedupKey：无法保证不重复回复同一目标')
  }
  if (task.sourceType && !SOURCE_TYPES.includes(task.sourceType)) {
    throw new Error(`未知来源渠道 ${task.sourceType}`)
  }

  return {
    id: task.id || makeTaskId(nowMs),
    kind: task.kind,
    sourceType: task.sourceType || null,
    dedupKey: task.dedupKey,
    // ⚠️ payload 里只允许放**哈希与定位信息**，绝不放评论/回复原文。
    //    原文留在页面里，需要时重新读取——这样磁盘上永远没有隐私数据。
    payload: task.payload || {},
    state: 'queued',
    attempts: 0,
    enqueuedAtMs: nowMs,
    takenAtMs: 0,
    finishedAtMs: 0,
    priority: Number(task.priority || 0),
  }
}

module.exports = {
  Queue,
  F_QUEUE,
  F_REPLIED,
  F_LEADS,
  MAX_QUEUE_SIZE,
  MAX_REPLIED_HISTORY,
  MAX_ATTEMPTS,
  TERMINAL_STATES,
  TASK_KINDS,
  makeTaskId,
  normalizeTask,
}
