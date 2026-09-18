'use strict'

// test/unit/client-queue.test.js
// 客户端任务队列测试。
//
// ⚠️ 本文件的核心命题是**"不丢任务、不重复回复、不卡死"**。
//    旧代码（docs/需求规格.md D-7）在循环开头读队列、循环结束全量覆写，
//    期间新增的任务全部丢失，且**无法复现**——丢不丢取决于循环期间
//    有没有新任务进来。所以这里的测试刻意模拟"边跑边加"。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { Store } = require('../../client/host/store')
const Q = require('../../client/host/queue')

const NOW = 1758096000000

function makeQueue(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-queue-'))
  const store = new Store({ dir })
  let t = opts.nowMs === undefined ? NOW : opts.nowMs
  const queue = new Q.Queue({ store, now: () => t })
  return {
    queue,
    store,
    dir,
    at: () => t,
    setTime: (v) => { t = v },
    reopen: () => {
      // ⚠️ 必须 close 再 new：Store 有 in-process 单写者守卫，
      //    不关掉就打不开第二次——这正是我们想要的行为。
      store.close()
      const s2 = new Store({ dir })
      return new Q.Queue({ store: s2, now: () => t })
    },
    cleanup: () => {
      store.close()
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
    },
  }
}

function task(overrides = {}) {
  return {
    kind: 'reply_comment',
    sourceType: 'comment',
    dedupKey: overrides.dedupKey || `dk-${Math.random().toString(16).slice(2, 10)}`,
    payload: { targetKey: 'video1:comment1', userKeyHash: 'uh-1' },
    ...overrides,
  }
}

// ══════════════════════════════════════════════════════════
// D-7 回归：不丢任务
// ══════════════════════════════════════════════════════════

test('队列：处理一条的同时新增任务，新增的不会被覆写丢掉（D-7 回归）', () => {
  const h = makeQueue()
  try {
    h.queue.add(task({ dedupKey: 'dk-1' }))

    // 模拟旧代码的形态：取出后、写回前，又来了新任务
    const t1 = h.queue.take()
    assert.ok(t1)
    assert.strictEqual(h.queue.add(task({ dedupKey: 'dk-2' })).added, true)
    h.queue.done(t1.id, { outcome: 'done' })

    const all = h.queue.list()
    assert.strictEqual(all.length, 2, '新增的任务必须还在')
    assert.strictEqual(all.filter((x) => x.state === 'queued').length, 1, 'dk-2 应仍在待办')
    assert.strictEqual(all.filter((x) => x.state === 'done').length, 1)
  } finally { h.cleanup() }
})

test('队列：连续取 3 条并在中间插入新任务，5 条全部保留', () => {
  const h = makeQueue()
  try {
    const ids = []
    for (let i = 0; i < 3; i++) {
      h.queue.add(task({ dedupKey: `dk-${i}` }))
      const t = h.queue.take()
      ids.push(t.id)
      h.queue.done(t.id, { outcome: 'done' })
    }
    h.queue.add(task({ dedupKey: 'dk-mid' }))
    h.queue.add(task({ dedupKey: 'dk-tail' }))
    assert.strictEqual(h.queue.size(), 5)
    assert.strictEqual(new Set(ids).size, 3, '取出的必须是三条不同的任务')
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 去重
// ══════════════════════════════════════════════════════════

test('队列：同 dedupKey 重复入队只算一次', () => {
  const h = makeQueue()
  try {
    assert.strictEqual(h.queue.add(task({ dedupKey: 'same' })).added, true)
    const again = h.queue.add(task({ dedupKey: 'same' }))
    assert.strictEqual(again.added, false)
    assert.strictEqual(again.reason, 'duplicate')
    assert.strictEqual(h.queue.size(), 1)
  } finally { h.cleanup() }
})

test('队列：已回复过的 dedupKey 不再入队（防止重复回复同一评论）', () => {
  const h = makeQueue()
  try {
    h.queue.markReplied({ dedupKey: 'dk-done', userKeyHash: 'uh-1', sourceType: 'comment' })
    assert.strictEqual(h.queue.hasReplied('dk-done'), true)
    const r = h.queue.add(task({ dedupKey: 'dk-done' }))
    assert.strictEqual(r.added, false)
    assert.strictEqual(r.reason, 'already_replied')
  } finally { h.cleanup() }
})

test('队列：同一用户在 24 小时窗口内只回复一次', () => {
  const h = makeQueue()
  try {
    h.queue.markReplied({ dedupKey: 'a', userKeyHash: 'uh-x', sourceType: 'comment' })
    assert.strictEqual(h.queue.userRepliedWithin('uh-x', 86400000, NOW + 1000), true)
    assert.strictEqual(h.queue.userRepliedWithin('uh-x', 86400000, NOW + 86400001), false,
      '超窗后应可再次回复')
    assert.strictEqual(h.queue.userRepliedWithin('uh-other', 86400000, NOW + 1000), false)
    assert.strictEqual(h.queue.userRepliedWithin(null, 86400000, NOW), false,
      '没有 userKeyHash 时不得误判为已回复')
  } finally { h.cleanup() }
})

test('队列：任务必须有 dedupKey，否则拒绝入队', () => {
  const h = makeQueue()
  try {
    assert.throws(() => h.queue.add({ kind: 'reply_comment', sourceType: 'comment' }), /dedupKey/)
    assert.throws(() => h.queue.add({ kind: 'nope', dedupKey: 'x' }), /未知任务类型/)
    assert.throws(() => h.queue.add({ kind: 'reply_comment', dedupKey: 'x', sourceType: 'weibo' }), /未知来源渠道/)
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 状态机
// ══════════════════════════════════════════════════════════

test('队列：take 一次只交付一条且立即标记 processing', () => {
  const h = makeQueue()
  try {
    h.queue.add(task({ dedupKey: 'a' }))
    h.queue.add(task({ dedupKey: 'b' }))
    const t1 = h.queue.take()
    assert.strictEqual(t1.state, 'processing')
    assert.strictEqual(t1.attempts, 1)
    const stats = h.queue.stats()
    assert.strictEqual(stats.processing, 1)
    assert.strictEqual(stats.queued, 1)
  } finally { h.cleanup() }
})

test('队列：FIFO —— 先入队的先被取出', () => {
  const h = makeQueue()
  try {
    h.queue.add(task({ dedupKey: 'first' }))
    h.setTime(NOW + 1000)
    h.queue.add(task({ dedupKey: 'second' }))
    const t = h.queue.take()
    assert.strictEqual(t.dedupKey, 'first', '早入队的必须先被处理，否则商家会觉得漏回复')
  } finally { h.cleanup() }
})

test('队列：requeue 保留原始入队时间，重试任务不会被排到队尾', () => {
  const h = makeQueue()
  try {
    h.queue.add(task({ dedupKey: 'urgent' }))
    h.setTime(NOW + 5000)
    h.queue.add(task({ dedupKey: 'later' }))
    const t = h.queue.take() // 取到 urgent
    assert.strictEqual(t.dedupKey, 'urgent')
    h.queue.requeue(t.id, 'TAB_LOST')
    const next = h.queue.take()
    assert.strictEqual(next.dedupKey, 'urgent',
      '重试的任务必须仍在队首，否则一条反复失败的任务会被饿死')
  } finally { h.cleanup() }
})

test('队列：requeue 超过 MAX_ATTEMPTS 后转 failed，不会无限重试', () => {
  const h = makeQueue()
  try {
    h.queue.add(task({ dedupKey: 'bad' }))
    for (let i = 0; i < Q.MAX_ATTEMPTS; i++) {
      const t = h.queue.take()
      assert.ok(t, `第 ${i + 1} 次应还能取到`)
      h.queue.requeue(t.id, 'TAB_LOST')
    }
    // attempts 已达上限，再取时它已不是 queued
    assert.strictEqual(h.queue.take(), null)
    const st = h.queue.stats()
    assert.strictEqual(st.failed, 1)
    assert.strictEqual(st.queued, 0)
  } finally { h.cleanup() }
})

test('队列：done / skip / fail 三个终态互不混淆', () => {
  const h = makeQueue()
  try {
    for (const k of ['d', 's', 'f']) h.queue.add(task({ dedupKey: k }))
    const td = h.queue.take(); h.queue.done(td.id, { outcome: 'done' })
    const ts = h.queue.take(); h.queue.skip(ts.id, 'user_replied_within_window')
    const tf = h.queue.take(); h.queue.fail(tf.id, 'CONTENT_REJECTED')
    const st = h.queue.stats()
    assert.strictEqual(st.done, 1)
    assert.strictEqual(st.skipped, 1)
    assert.strictEqual(st.failed, 1)
    assert.strictEqual(st.queued, 0)
  } finally { h.cleanup() }
})

test('队列：对不存在或终态的任务做转换，返回结构化的 task_not_found 而不抛错', () => {
  const h = makeQueue()
  try {
    const r = h.queue.done('t-nonexistent')
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.reason, 'task_not_found')
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 崩溃恢复
// ══════════════════════════════════════════════════════════

test('队列：崩溃恢复 —— 遗留的 processing 任务回到 queued，重启后仍会被处理', () => {
  const h = makeQueue()
  try {
    h.queue.add(task({ dedupKey: 'inflight' }))
    const t = h.queue.take()
    assert.strictEqual(t.state, 'processing')

    // ── 模拟进程被杀（不调用 done/fail，直接换一个 Queue 实例）──
    const q2 = h.reopen()
    const before = q2.stats()
    assert.strictEqual(before.processing, 1, '重启时确实存在 in-flight 任务')

    const rec = q2.recoverInFlight()
    assert.strictEqual(rec.recovered, 1)
    assert.strictEqual(q2.stats().queued, 1, '必须回到待办，否则这条评论永远不会被回复')

    const again = q2.take()
    assert.strictEqual(again.dedupKey, 'inflight')
    assert.strictEqual(again.attempts, 2, 'attempts 必须累计，否则坏任务会无限重试')
  } finally { h.cleanup() }
})

test('队列：重启后 attempts 已达上限的 in-flight 任务转 failed（不再无限重试）', () => {
  const h = makeQueue()
  try {
    h.queue.add(task({ dedupKey: 'x' }))
    for (let i = 0; i < Q.MAX_ATTEMPTS; i++) {
      const t = h.queue.take()
      if (t) h.queue.requeue(t.id, 'r')
    }
    // 手工造一个 attempts 顶格的 processing 状态
    h.store.update(Q.F_QUEUE, [], (list) => {
      list[0] = { ...list[0], state: 'processing' }
      return list
    })
    const q2 = h.reopen()
    const rec = q2.recoverInFlight()
    assert.strictEqual(rec.recovered, 1)
    assert.strictEqual(q2.stats().failed, 1)
    assert.strictEqual(q2.stats().queued, 0)
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 容量与清理
// ══════════════════════════════════════════════════════════

test('队列：满时拒绝新增而不是静默淘汰最旧的', () => {
  const h = makeQueue()
  try {
    // ⚠️ 直接构造满队列，避免在测试里真的塞 5000 条。
    h.store.writeJson(Q.F_QUEUE, [])
    h.store.update(Q.F_QUEUE, [], (list) => {
      for (let i = 0; i < Q.MAX_QUEUE_SIZE; i++) {
        list.push({
          id: `t-${i}`, kind: 'reply_comment', sourceType: 'comment',
          dedupKey: `k-${i}`, payload: {}, state: 'queued', attempts: 0,
          enqueuedAtMs: NOW + i, takenAtMs: 0, finishedAtMs: 0, priority: 0,
        })
      }
      return list
    })
    const r = h.queue.add(task({ dedupKey: 'overflow' }))
    assert.strictEqual(r.added, false)
    assert.strictEqual(r.reason, 'queue_full')
    assert.strictEqual(h.queue.size(), Q.MAX_QUEUE_SIZE,
      '不能淘汰最旧的——那等于悄悄不回复早期用户')
  } finally { h.cleanup() }
})

test('队列：prune 只清早于阈值的终态，failed 一律保留', () => {
  const h = makeQueue()
  try {
    h.queue.add(task({ dedupKey: 'old-done' }))
    const td = h.queue.take(); h.queue.done(td.id, {})
    h.queue.add(task({ dedupKey: 'old-failed' }))
    const tf = h.queue.take(); h.queue.fail(tf.id, 'CONTENT_REJECTED')
    h.queue.add(task({ dedupKey: 'pending' }))

    h.setTime(NOW + 8 * 86400000)
    const r = h.queue.prune({ beforeMs: NOW + 86400000 })
    assert.strictEqual(r.removed, 1, '只应清掉那条早于阈值的 done')
    const left = h.queue.list().map((x) => x.dedupKey).sort()
    assert.deepStrictEqual(left, ['old-failed', 'pending'],
      'failed 是排障与举证依据，必须保留')
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 线索
// ══════════════════════════════════════════════════════════

test('线索：同一用户只记一条，且只存哈希', () => {
  const h = makeQueue()
  try {
    assert.strictEqual(h.queue.addLead({ userKeyHash: 'uh-1', sourceType: 'comment' }).added, true)
    assert.strictEqual(h.queue.addLead({ userKeyHash: 'uh-1', sourceType: 'comment' }).added, false)
    assert.strictEqual(h.queue.leadCount(), 1)
    const raw = fs.readFileSync(h.store.file(Q.F_LEADS), 'utf8')
    assert.ok(!raw.includes('sec_uid'), '线索里不得出现 sec_uid 原文（红线 3）')
    assert.ok(!raw.includes('nickname'), '线索里不得出现昵称')
  } finally { h.cleanup() }
})
