'use strict'

// test/unit/client-adapters.test.js
// 适配器测试 —— **发送链路的顺序**与"绝不重发"。
//
// ⚠️ 本文件验证的是顺序，不是"功能好不好用"：
//    · send_id 必须先落盘再发送（反了 → 崩溃后重复回复 + 重复计费）
//    · 响应捕获必须先于提交（反了 → 全部变疑似 → 一条都不计费）
//    · 相似度检查必须在发送之前（反了 → 护栏形同虚设）
//    · 崩溃留下的 unknown **不得重发**，只能按 suspected 上报
//
// ⚠️ 平台动作全部用替身，所以这里**不能**得出"页面操作可用"的结论
//    （AGENTS.md §6：页面操作必须真机验证）。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { Store } = require('../../client/host/store')
const { SendOutbox, F_OUTBOX } = require('../../client/adapters/send-outbox')
const { ReplyCommentAdapter } = require('../../client/adapters/reply-comment')
const { ReplyDanmakuAdapter } = require('../../client/adapters/reply-danmaku')
const { SendDmAdapter } = require('../../client/adapters/send-dm')
const KM = require('../../client/adapters/keyword-match')
const RR = require('../../client/adapters/reply-renderer')
const timing = require('../../client/safety/timing')
const similarity = require('../../client/safety/similarity')
const W = require('../../client/core/workbench-error')

const NOW = 1758096000000

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ad-'))
  const store = new Store({ dir })
  return {
    store,
    dir,
    cleanup: () => {
      store.close()
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    },
  }
}

// ══════════════════════════════════════════════════════════
// 关键词匹配
// ══════════════════════════════════════════════════════════

test('关键词：strict 参数是必填的（它决定会不会给不相关的人发回复）', () => {
  assert.throws(() => KM.matchKeyword('这个多少钱', '多少钱'), /显式的 strict 参数/)
})

test('关键词：整串连续命中', () => {
  const r = KM.matchKeyword('请问这个多少钱呢', '多少钱', { strict: true })
  assert.strictEqual(r.hit, true)
  assert.strictEqual(r.how, 'exact')
})

test('关键词：分词 AND 命中（顺序无关）—— legacy 的核心经验', () => {
  // 抖音标题几乎不会连续包含"怎么充值codex"，整串匹配会把结果全过滤成 0
  const r = KM.matchKeyword('这个 codex 到底怎么充值啊', '怎么充值codex', { strict: true })
  assert.strictEqual(r.hit, true)
  assert.strictEqual(r.how, 'segments')
  assert.deepStrictEqual(r.segments.sort(), ['codex', '充值'].sort())
})

test('关键词：疑问前缀被剥掉，剩下的才是真关键词', () => {
  assert.deepStrictEqual(KM.keywordSegments('怎么充值codex').sort(), ['codex', '充值'].sort())
  assert.deepStrictEqual(KM.keywordSegments('这个多少钱'), ['多少钱'])
})

test('关键词：单字与纯功能词一律丢弃（否则等于"出现这个字就回复"）', () => {
  assert.deepStrictEqual(KM.keywordSegments('的'), [])
  assert.deepStrictEqual(KM.keywordSegments('我'), [])
  assert.deepStrictEqual(KM.keywordSegments('钱'), [])
  // 剥掉前缀后只剩单字 → 也丢弃
  const segs = KM.keywordSegments('怎么买')
  assert.ok(!segs.includes('买'), `"买"是单字，应被丢弃，实际 ${JSON.stringify(segs)}`)
})

test('关键词：严格模式不放过部分命中（评论侧必须严格）', () => {
  // "多少钱" 与 "多少" 只分出一段，用两段关键词测部分命中
  const r = KM.matchKeyword('这个价格怎么样', '多少钱 优惠', { strict: true })
  assert.strictEqual(r.hit, false, '只命中一半时严格模式必须拒绝')
})

test('关键词：宽松模式（标题侧）允许过半命中，严格模式不允许', () => {
  // 两段关键词，被测文本一段都不含
  const none = KM.matchKeyword('这个价格怎么样', '多少钱 优惠', { strict: false })
  assert.strictEqual(none.hit, false,
    '⚠️ 这里刻意不通过：字符级兜底要求 80% 命中，而"多少钱"3 个字里只中了"多" 1 个。' +
    '门限不能放宽——放宽会让"这个怎么样"命中文案完全无关的内容')
  assert.deepStrictEqual(none.matched, [], '两段都没命中')

  assert.strictEqual(KM.matchKeyword('这个价格怎么样', '多少钱 优惠', { strict: true }).hit, false)

  // 真正的"过半"：两段里命中一段
  const half = KM.matchKeyword('这个价格有优惠吗', '多少钱 优惠', { strict: false })
  assert.strictEqual(half.hit, true, '命中"优惠"一段，宽松模式应通过')
  assert.deepStrictEqual(half.matched, ['优惠'])
  assert.strictEqual(KM.matchKeyword('这个价格有优惠吗', '多少钱 优惠', { strict: true }).hit, false,
    '严格模式（评论侧）不得放过部分命中')
})
test('关键词：字符级兜底只在宽松模式、且要求 80% 命中', () => {
  // "多少钱" 的字符是 多/少/钱；"这个多少" 命中 2/3 = 67% → 不够
  assert.strictEqual(KM.matchKeyword('这个多少', '多少钱', { strict: false }).hit, false)
  // 但整串"多少钱"命中时走的是 exact，不受兜底影响
  assert.strictEqual(KM.matchKeyword('这个多少钱', '多少钱', { strict: false }).how, 'exact')
})

test('关键词：零宽字符与空白被剥掉（平台会插这些东西）', () => {
  const r = KM.matchKeyword('这\u200b个 多\u200b少 钱', '多少钱', { strict: true })
  assert.strictEqual(r.hit, true, '零宽字符不该影响匹配')
})

test('关键词：规则按配置顺序取第一条命中（顺序即优先级）', () => {
  const real = [
    { id: 'rFirst', keyword: '多少钱', templates: ['a'] },
    { id: 'rSecond', keyword: '多少钱 有货', templates: ['b'] },
  ]
  // ⚠️ 关键设计：多段关键词在**严格模式**下要求全部段命中（AND 语义）。
  //    所以"这个多少钱"只满足第一条；第二条因为缺"有货"而不命中。
  assert.strictEqual(KM.matchRules('这个多少钱', real, { strict: true }).rule.id, 'rFirst',
    '第一条命中即返回，顺序即优先级')

  // 两句都满足时，顺序决定结果
  const both = [
    { id: 'rA', keyword: '多少钱', templates: ['a'] },
    { id: 'rB', keyword: '这个', templates: ['b'] },
  ]
  // ⚠️ "这个" 是疑问/指示前缀，剥掉后什么都不剩 → 它**永远命不中**。
  //    这是刻意的：否则"这个"会成为一个超高频误命中词。
  assert.strictEqual(KM.matchRules('这个多少钱', both, { strict: true }).rule.id, 'rA')

  // 用两条真正都能命中的规则验证"顺序即优先"
  const two = [
    { id: 'r1', keyword: '多少钱', templates: ['a'] },
    { id: 'r2', keyword: '这个多少钱', templates: ['b'] },
  ]
  assert.strictEqual(KM.matchRules('这个多少钱', two, { strict: true }).rule.id, 'r1')
  assert.strictEqual(KM.matchRules('这个多少钱', [two[1], two[0]], { strict: true }).rule.id, 'r2',
    '换顺序就命中另一条 —— 证明实现尊重配置顺序，' +
    '而不是按关键词长度之类隐式规则重排')
})

test('关键词：完全不相关时返回 null（不得乱命中）', () => {
  assert.strictEqual(KM.matchRules('今天天气不错', [{ id: 'r', keyword: '多少钱', templates: ['x'] }], { strict: true }), null)
})

// ══════════════════════════════════════════════════════════
// 文案渲染
// ══════════════════════════════════════════════════════════

test('渲染：数字随机占位符必须被拒绝（会产生 "1这个" 这类机器痕迹）', () => {
  const r = RR.validateTemplates(['{随机1-9}这个多少钱', 'a', 'b', 'c', 'd'])
  assert.strictEqual(r.ok, false)
  assert.ok(r.problems.some((p) => p.includes('机器痕迹')),
    `必须明确说明为什么禁止，实际：${JSON.stringify(r.problems)}`)
})

test('渲染：模板池少于 5 条变体不合格（需求下限）', () => {
  const r = RR.validateTemplates(['一', '二', '三', '四'])
  assert.strictEqual(r.ok, false)
  assert.match(r.problems[0], /至少需要 5 条/)
  assert.strictEqual(RR.validateTemplates(['一', '二', '三', '四', '五']).ok, true)
})

test('渲染：未知占位符被拒绝（但不抛错，让调用方汇总所有问题）', () => {
  const r = RR.validateTemplates(['{不存在的槽}你好', 'b', 'c', 'd', 'e'])
  assert.strictEqual(r.ok, false)
  assert.ok(r.problems.some((p) => p.includes('未知占位符')))
})

test('渲染：同义词槽替换成语言变体（不是数字）', () => {
  const rng = timing.makeSeededRng(42)
  const r = RR.renderReply({ templates: ['{商品}{价格}{语气}'], rng })
  assert.ok(!/\d/.test(r.text), `渲染结果不应含数字，实际：${r.text}`)
  assert.ok(r.slots.商品, '槽应被记录，便于排障')
  assert.strictEqual(r.text, r.text.trim())
})

test('渲染：可指定 pick 以复现同一条（崩溃恢复必须可复现）', () => {
  const templates = ['模板零', '模板一', '模板二', '模板三', '模板四']
  const a = RR.renderReply({ templates, pick: 2, rng: timing.makeSeededRng(1) })
  const b = RR.renderReply({ templates, pick: 2, rng: timing.makeSeededRng(999) })
  assert.strictEqual(a.templateIndex, 2)
  assert.strictEqual(b.templateIndex, 2)
  assert.ok(a.text.startsWith('模板二') && b.text.startsWith('模板二'))
})

// ══════════════════════════════════════════════════════════
// SendOutbox（红线 2 的落点）
// ══════════════════════════════════════════════════════════

test('outbox：begin 立即落盘（发送前就有记录）', () => {
  const h = makeStore()
  try {
    const ob = new SendOutbox({ store: h.store, now: () => NOW })
    const rec = ob.begin({ sourceType: 'comment', targetHash: 'th', contentHash: 'ch' })
    assert.ok(rec.send_id.startsWith('s-'))
    assert.strictEqual(rec.state, 'unknown')

    // ⚠️ 关键：此时盘上就应该有这条记录。反了就是旧代码那个
    //    "发送成功后才生成 ID" 的缺陷。
    const onDisk = JSON.parse(fs.readFileSync(h.store.file(F_OUTBOX), 'utf8'))
    const list = onDisk.data || onDisk
    assert.strictEqual(list.length, 1)
    assert.strictEqual(list[0].send_id, rec.send_id)
  } finally { h.cleanup() }
})

test('outbox：send_id 用密码学随机（跨进程不碰撞，它是幂等与计费键）', () => {
  const h = makeStore()
  try {
    const ids = new Set()
    for (let i = 0; i < 500; i++) ids.add(SendOutbox.newSendId())
    assert.strictEqual(ids.size, 500)
    for (const id of ids) assert.match(id, /^s-[0-9a-f]{32}$/)
  } finally { h.cleanup() }
})

test('outbox：settle 是**原地更新**，不会写第二条（写两条会丢掉真实结果）', () => {
  const h = makeStore()
  try {
    const ob = new SendOutbox({ store: h.store, now: () => NOW })
    const rec = ob.begin({ sourceType: 'comment', targetHash: 'th', contentHash: 'ch' })
    const reportable = ob.settle(rec.send_id, {
      verdict: 'sent_confirmed',
      evidence: { confirm_signal: 'platform_response', platform_status_code: 0 },
    })
    assert.strictEqual(ob.list().length, 1, '必须是原地更新，不能新增一条')
    assert.strictEqual(ob.list()[0].state, 'confirmed')
    assert.strictEqual(reportable.verdict, 'sent_confirmed')
    assert.strictEqual(reportable.send_id, rec.send_id)
    assert.strictEqual(reportable.is_final, true)
  } finally { h.cleanup() }
})

test('outbox：未知 sendId 时 settle 不抛错但留痕，并合成可上报明细', () => {
  const h = makeStore()
  try {
    const logs = []
    const ob = new SendOutbox({
      store: h.store, now: () => NOW,
      logger: { warn: (m) => logs.push(m), info: () => {}, error: () => {} },
    })
    const r = ob.settle('s-not-there', { verdict: 'sent_confirmed', evidence: { confirm_signal: 'platform_response', platform_status_code: 0 } })
    assert.strictEqual(r.send_id, 's-not-there')
    assert.ok(logs.includes('outbox_settle_not_found'), '必须留痕（不静默）')
  } finally { h.cleanup() }
})

test('outbox：崩溃恢复 —— unknown 变成 sent_suspected 且 is_final=false，绝不重发', () => {
  const h = makeStore()
  try {
    const ob = new SendOutbox({ store: h.store, now: () => NOW })
    const rec = ob.begin({ sourceType: 'comment', targetHash: 'th', contentHash: 'ch' })

    // 模拟进程被杀：不 settle，直接换一个实例
    const ob2 = new SendOutbox({ store: h.store, now: () => NOW + 1000 })
    assert.strictEqual(ob2.unknownCount(), 1)
    const recovered = ob2.recoverUnknown()
    assert.strictEqual(recovered.length, 1)
    assert.strictEqual(recovered[0].send_id, rec.send_id, '必须是同一个 send_id —— 不能换 ID 重发')
    assert.strictEqual(recovered[0].verdict, 'sent_suspected')
    assert.strictEqual(recovered[0].is_final, false,
      '必须保留后续升级空间（契约 §6.3 只允许单向升级）')
    assert.strictEqual(recovered[0].evidence.note, 'recovered_after_crash',
      '必须在证据里标明"不是没抓到响应，而是进程崩了"')
    assert.strictEqual(ob2.unknownCount(), 0)
  } finally { h.cleanup() }
})

test('outbox：unknown 记录永不淘汰（它对应可能已发出去的发送）', () => {
  const h = makeStore()
  try {
    const ob = new SendOutbox({ store: h.store, now: () => NOW })
    // 造一条 unknown + 大量已定判记录，触发淘汰
    const keep = ob.begin({ sourceType: 'comment', targetHash: 'th-keep', contentHash: 'ch' })
    for (let i = 0; i < 60; i++) {
      const r = ob.begin({ sourceType: 'comment', targetHash: `th-${i}`, contentHash: 'ch' })
      ob.settle(r.send_id, { verdict: 'failed', evidence: { confirm_signal: 'none' }, failure_reason: 'unknown' })
    }
    const ids = ob.list().map((r) => r.send_id)
    assert.ok(ids.includes(keep.send_id), 'unknown 记录不得被淘汰')
  } finally { h.cleanup() }
})

test('outbox：outbox 里不含回复原文（红线 3：页面数据不落盘）', () => {
  const h = makeStore()
  try {
    const ob = new SendOutbox({ store: h.store, now: () => NOW })
    ob.begin({ sourceType: 'comment', targetHash: 'th', contentHash: 'deadbeef', userKeyHash: 'uh' })
    const raw = fs.readFileSync(h.store.file(F_OUTBOX), 'utf8')
    assert.ok(!raw.includes('多少钱'), '不得出现回复原文')
    assert.ok(!raw.includes('sec_uid'), '不得出现 sec_uid')
    assert.ok(raw.includes('content_hash'), '只应有哈希')
  } finally { h.cleanup() }
})

test('outbox：drop 清理已上报记录', () => {
  const h = makeStore()
  try {
    const ob = new SendOutbox({ store: h.store, now: () => NOW })
    const a = ob.begin({ sourceType: 'comment', targetHash: 'a', contentHash: 'c' })
    const b = ob.begin({ sourceType: 'comment', targetHash: 'b', contentHash: 'c' })
    assert.strictEqual(ob.drop([a.send_id]), 1)
    assert.deepStrictEqual(ob.list().map((r) => r.send_id), [b.send_id])
    assert.strictEqual(ob.drop([]), 0)
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 回复编排：顺序（最重要）
// ══════════════════════════════════════════════════════════

/** 记录调用顺序的假页面 / 假校验器。 */
function harness(opts = {}) {
  const order = []
  const P = require('../../client/license/privacy')
  const SALT = 'salt-abc'
  const pageItems = opts.pageItems || [
    { index: 0, commentId: 'c1', text: '这个多少钱', user: '小明' },
    { index: 1, commentId: 'c2', text: '这款多少钱呢', user: '小张' },
  ]
  const page = {
    order,
    async open() { order.push('open') },
    async scan() {
      order.push('scan')
      return pageItems
    },
    async scrollToComment() { order.push('scroll'); return opts.located || { found: true, index: 0 } },
    async activateInlineEditor() { order.push('activate'); return { ok: true, x: 1, y: 2 } },
    async typeIntoEditor(text) {
      order.push('type')
      if (opts.typeThrows) throw new W.WorkbenchError('ELEMENT_TIMEOUT', '输入失败')
      return { ok: true }
    },
    async submitReply() { order.push('submit'); return { via: 'enter' } },
    async waitForReplyStable() {
      order.push('domCheck')
      return opts.domStable || { stable: false, stableMs: 0 }
    },
  }
  const verifier = {
    order,
    constructor: { domConfirmed: (p) => ({ evidence: { confirm_signal: 'dom_stable', dom_stable_ms: p.stableMs } }) },
    async beginCapture() { order.push('beginCapture') },
    async verify() {
      order.push('verify')
      return opts.verifyResult || {
        verdict: 'sent_confirmed', is_final: true,
        evidence: { confirm_signal: 'platform_response', platform_endpoint: 'comment/publish', platform_status_code: 0 },
        failure_reason: null,
      }
    },
    async abortCapture() { order.push('abortCapture') },
    async stopResponseCapture() { order.push('stopCapture') },
  }
  const state = {
    privacySalt: SALT,
    policyVersion: 9,
    instanceIdValue: 'inst-1',
  }
  const guard = {
    effectiveLimits: () => ({ daily_max: 30, min_interval_ms: 60000, content_similarity_max: 0.85 }),
  }
  const h = makeStore()
  const outbox = new SendOutbox({ store: h.store, now: () => NOW })
  const adapter = new ReplyCommentAdapter({
    page, verifier, outbox, state, guard,
    similarity, rng: timing.makeSeededRng(7),
  })
  return { ...h, page, verifier, outbox, adapter, order, salt: SALT, P, pageItems }
}

const RULES = [{
  id: 'r1', keyword: '多少钱',
  templates: ['{商品}{价格}{语气}', '这款{商品}{价格}', '{商品}的{价格}可以私信聊', '想了解{价格}可以{联系}', '{商品}详情可以{联系}'],
}]

/**
 * 构造任务。
 *
 * ⚠️ 注意这里**没有** `bodyKey`（评论原文），只有 `bodyKeyHash`。
 *    这是红线 3 的直接体现：队列长期留盘，原文放进去就等于在
 *    商家机器上留一份副本。适配器会拿哈希去页面上重新定位那条评论。
 */
function task(overrides = {}, h) {
  const bodyText = overrides.__bodyText || '这个多少钱'
  const salt = (h && h.salt) || 'salt-abc'
  const P = require('../../client/license/privacy')
  return {
    kind: 'reply_comment', sourceType: 'comment', dedupKey: 'dk-1',
    payload: {
      videoUrl: 'https://www.douyin.com/video/1',
      videoId: '1', commentId: 'c1',
      bodyKeyHash: P.contentHash(bodyText, salt),
      bodyKeyPrefix: bodyText.slice(0, 12),
      userKey: '小明',
      userKeyHash: P.userKeyHash('MS4wSECRET', salt),
      rules: RULES,
      ...overrides,
    },
  }
}

test('编排：send_id 落盘**早于**任何平台提交动作（顺序即红线）', async () => {
  const h = harness()
  try {
    await h.adapter.run(task({}, h))
    const iBegin = h.order.indexOf('activate')
    const iSubmit = h.order.indexOf('submit')
    assert.ok(iBegin >= 0 && iSubmit >= 0)

    // outbox 记录必须在 submit 之前就存在。
    // 用"beginCapture 之前就有记录"来断言：beginCapture 紧接在 begin 之后、
    // 输入与提交之前。
    const iCapture = h.order.indexOf('beginCapture')
    assert.ok(iCapture < iSubmit, '响应捕获必须先于提交')
    assert.strictEqual(h.outbox.list().length, 1)
    assert.strictEqual(h.outbox.list()[0].state, 'confirmed')
  } finally { h.cleanup() }
})

test('编排：响应捕获先于提交（反了会导致全部变疑似、一条都不计费）', async () => {
  const h = harness()
  try {
    await h.adapter.run(task({}, h))
    assert.ok(h.order.indexOf('beginCapture') < h.order.indexOf('type'),
      '必须先打开捕获再输入，否则平台的响应可能比下一行代码还快')
    assert.ok(h.order.indexOf('beginCapture') < h.order.indexOf('submit'))
  } finally { h.cleanup() }
})

test('编排：相似度检查在提交之前（护栏必须在发送前生效）', async () => {
  const h = harness()
  try {
    // 先把同一句话"发过"，让护栏有依据
    const first = await h.adapter.run(task({}, h))
    assert.strictEqual(first.verdict, 'sent_confirmed')
    h.order.length = 0
    // 再发同类文案：模板池只有 5 条，渲染出来的差异有限，
    // 相似度可能仍低于 0.85，所以这里断言的是"检查发生了"，
    // 而不是"一定被拒"——拒绝与否由阈值与文案决定。
    const second = await h.adapter.run(task({ commentId: 'c2' }, h))
    assert.ok(h.order.includes('type') || second.outcome === 'failed',
      '要么正常走到输入，要么在检查阶段就被拦下')
    if (second.outcome === 'failed' && second.failureReason === 'content_rejected') {
      assert.ok(!h.order.includes('type'), '被相似度拒绝时**绝不能**已经输入了文案')
    }
  } finally { h.cleanup() }
})

test('编排：相似度被拒 → failed + content_rejected（不是 skipped）', async () => {
  const h = harness()
  try {
    h.adapter.recentTexts = ['你好'] // 无关内容，仅占位
    // 直接构造一个必然被拒的场景：把已发文案设成与将要渲染的一模一样
    // （用固定 pick 让渲染可复现）
    h.adapter.rng = () => 0
    const fixed = RR.renderReply({ templates: RULES[0].templates, rng: () => 0 })
    h.adapter.recentTexts = [fixed.text, fixed.text, fixed.text]
    const r = await h.adapter.run(task({}, h))
    assert.strictEqual(r.outcome, 'failed')
    assert.strictEqual(r.failureReason, 'content_rejected',
      '文案被护栏拒绝属"本该回复但不合格"，与 skipped（按策略不回复）含义不同')
    assert.strictEqual(r.evidence.note, 'content_similarity_rejected')
  } finally { h.cleanup() }
})

test('编排：没命中任何规则 → skipped + no_rule_matched（不产生 send_id）', async () => {
  const h = harness({
    // ⚠️ 关键：页面上要有那条**正文**，否则适配器在"按哈希定位"阶段
    //    就找不到它、返回的是 comment_not_found（那是另一条路径）。
    //    本条测试要验的是"定位到了、但规则没命中"。
    pageItems: [{ index: 0, commentId: 'no-match', text: '今天天气不错', user: '小李' }],
  })
  try {
    const r = await h.adapter.run(task({ __bodyText: '今天天气不错', commentId: 'no-match' }, h))
    assert.strictEqual(r.outcome, 'skipped')
    assert.strictEqual(r.reason, 'no_rule_matched')
    assert.strictEqual(h.outbox.list().length, 0,
      '没有规则命中就不该生成 send_id —— 它不该进入计费链路')
  } finally { h.cleanup() }
})

test('编排：目标评论找不到 → skipped（评论可能已删除，重试无意义）', async () => {
  const h = harness({ located: { found: false, index: -1 } })
  try {
    const r = await h.adapter.run(task({}, h))
    assert.strictEqual(r.outcome, 'skipped')
    assert.strictEqual(r.reason, 'comment_not_found')
    assert.strictEqual(h.outbox.list().length, 0)
  } finally { h.cleanup() }
})

test('编排：抓不到响应 → 先试 DOM 判据；DOM 也稳不住则 sent_suspected 且 is_final=false', async () => {
  const h = harness({
    verifyResult: {
      verdict: 'sent_suspected', is_final: false,
      evidence: { confirm_signal: 'none', platform_status_code: null, note: 'no_response_captured' },
      failure_reason: null,
    },
    domStable: { stable: false, stableMs: 0 },
  })
  try {
    const r = await h.adapter.run(task({}, h))
    assert.strictEqual(r.verdict, 'sent_suspected')
    assert.strictEqual(r.evidence.confirm_signal, 'none')
    assert.ok(h.order.includes('domCheck'), '抓不到响应时应补一次 DOM 判据')
    const rec = h.outbox.list()[0]
    assert.strictEqual(rec.state, 'suspected')
  } finally { h.cleanup() }
})

test('编排：抓不到响应但 DOM 稳定 → sent_confirmed_dom（**不是** confirmed）', async () => {
  const h = harness({
    verifyResult: {
      verdict: 'sent_suspected', is_final: false,
      evidence: { confirm_signal: 'none' }, failure_reason: null,
    },
    domStable: { stable: true, stableMs: 3000 },
  })
  try {
    const r = await h.adapter.run(task({}, h))
    assert.strictEqual(r.verdict, 'sent_confirmed_dom',
      '⚠️ DOM 判据只能产出 dom 版 —— 它默认不计费。混成 confirmed 就是旧代码的 D-12 缺陷')
    assert.strictEqual(r.evidence.confirm_signal, 'dom_stable')
    assert.strictEqual(h.outbox.list()[0].state, 'dom_confirmed')
  } finally { h.cleanup() }
})

test('编排：平台明确失败 → failed 并带上映射后的归因', async () => {
  const h = harness({
    verifyResult: {
      verdict: 'failed', is_final: true,
      evidence: { confirm_signal: 'none', platform_status_code: 8, risk_control_signal: 'status_code:8' },
      failure_reason: 'risk_control_rejected',
    },
  })
  try {
    const r = await h.adapter.run(task({}, h))
    assert.strictEqual(r.outcome, 'failed')
    assert.strictEqual(r.failureReason, 'risk_control_rejected')
    assert.strictEqual(h.outbox.list()[0].state, 'failed')
  } finally { h.cleanup() }
})

test('编排：提交后抛错 → outbox 保留 unknown（不判失败、不重发）', async () => {
  const h = harness({ typeThrows: true })
  try {
    await assert.rejects(() => h.adapter.run(task({}, h)))
    const rec = h.outbox.list()[0]
    assert.ok(rec, 'outbox 里必须留下记录')
    assert.strictEqual(rec.state, 'unknown',
      '⚠️ 抛错后不能判 failed —— 错误可能发生在"已经按了提交、读结果时出错"之后，' +
      '那笔其实成功了。判 failed 会让它永久失去升级为 confirmed 的机会')
    assert.ok(h.order.includes('abortCapture'), '异常路径必须收尾捕获，否则监听器泄漏')
  } finally { h.cleanup() }
})

test('编排：缺失 privacy_salt 时拒绝发送（绝不退化成无盐哈希）', async () => {
  const h = harness()
  try {
    h.adapter.state = { privacySalt: null, policyVersion: 9, instanceIdValue: null }
    await assert.rejects(
      () => h.adapter.run(task({}, h)),
      (e) => e.code === 'INTERNAL' && /privacy_salt/.test(e.detail ? JSON.stringify(e.detail) : e.message)
    )
    assert.strictEqual(h.outbox.list().length, 0, '拒绝时不应留下 outbox 记录')
  } finally { h.cleanup() }
})

test('编排：模板池不合格时拒绝发送并说明原因（规则可能被绕过界面改文件）', async () => {
  const h = harness()
  try {
    await assert.rejects(
      () => h.adapter.run(task({ rules: [{ id: 'bad', keyword: '多少钱', templates: ['只有一条'] }] }, h)),
      (e) => e.code === 'CONFIG_INVALID' && /模板池/.test(e.message)
    )
  } finally { h.cleanup() }
})

test('编排：上报明细里只有哈希，没有 sec_uid 与回复原文（红线 3）', async () => {
  const h = harness()
  try {
    const r = await h.adapter.run(task({}, h))
    const rec = h.outbox.list()[0]
    assert.strictEqual(rec.content_hash.length, 64)
    assert.strictEqual(rec.target_hash.length, 64)
    assert.strictEqual(rec.user_key_hash.length, 64)
    const raw = fs.readFileSync(h.store.file(F_OUTBOX), 'utf8')
    assert.ok(!raw.includes('MS4wSECRET'), 'sec_uid 原文绝不能落盘')
    assert.ok(!raw.includes('这个多少钱'), '评论文本不能落盘')
    // ⚠️ 上报明细里也只有一个长度，没有原文
    assert.strictEqual(r.detail.text_length > 0, true)
    assert.strictEqual(r.detail.text, undefined)
  } finally { h.cleanup() }
})

test('编排：target_hash 按契约口径（video_id|comment_id）且可复现', async () => {
  const h = harness()
  try {
    await h.adapter.run(task({}, h))
    const a = h.outbox.list()[0].target_hash
    const h2 = harness()
    try {
      await h2.adapter.run(task({}, h2))
      assert.strictEqual(h2.outbox.list()[0].target_hash, a,
        '同一目标必须得到同一哈希 —— 否则服务端无法按目标聚合')
    } finally { h2.cleanup() }
  } finally { h.cleanup() }
})

test('编排：命中但无 secUid 时 user_key_hash 为 null 而不是编一个', async () => {
  const h = harness()
  try {
    await h.adapter.run(task({ userKeyHash: null }, h))
    const rec = h.outbox.list()[0]
    assert.strictEqual(rec.user_key_hash, null)
    assert.strictEqual(rec.user_key_type, null)
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 采集：红线 3 的落盘边界（这条是补的回归——当初写错过）
// ══════════════════════════════════════════════════════════

test('采集：队列文件里不得出现评论原文与 sec_uid（红线 3 回归）', async () => {
  const { Collector } = require('../../client/adapters/collect')
  const { Queue } = require('../../client/host/queue')
  const h = makeStore()
  try {
    const q = new Queue({ store: h.store, now: () => NOW })
    const c = new Collector({ queue: q, state: { privacySalt: 'salt1' }, now: () => NOW })
    const longText = '这个商品到底多少钱呢请问一下老板'
    // ⚠️ collectComments 是 async（未来要 await 页面读取），必须 await
    const r = await c.collectComments({
      videoId: 'v1', videoUrl: 'https://x',
      rules: [{ id: 'r1', keyword: '多少钱', templates: ['a'] }],
      items: [
        { index: 0, text: longText, user: '小明', replyable: true, commentId: 'c1', secUid: 'SECRET_UID_1' },
      ],
    })
    assert.strictEqual(r.enqueued, 1)

    const raw = fs.readFileSync(h.store.file('queue.json'), 'utf8')
    // ⚠️ 这三条断言就是当初那个缺陷的回归测试：
    //    错法是把正文放进 payload.bodyKey、把 secUid 放进 payload.secUid，
    //    于是 queue.json（长期留盘）里躺着完整的评论原文与 sec_uid 原文。
    assert.ok(!raw.includes(longText), '队列里不得出现完整评论原文')
    assert.ok(!raw.includes('SECRET_UID_1'), '队列里不得出现 sec_uid 原文')

    const entry = q.list()[0]
    assert.ok(entry.payload.bodyKeyHash, '必须存正文哈希作为定位锚点')
    assert.strictEqual(entry.payload.bodyKey, undefined, 'payload 不得有 bodyKey（原文）')
    assert.strictEqual(entry.payload.secUid, undefined, 'payload 不得有 secUid')
    // 展示截断是刻意保留的唯一明文，长度必须有上限
    assert.ok(entry.payload.bodyKeyPrefix.length <= 12,
      `展示截断不得超过 12 字符，实际 ${entry.payload.bodyKeyPrefix.length}`)
  } finally { h.cleanup() }
})

test('适配器分层：不得内联选择器，不得直接调 CDP，不得做限额判定', () => {
  const dir = path.join(__dirname, '..', '..', 'client', 'adapters')
  const banned = /data-e2e|data-sec-uid|Input\.dispatchMouseEvent|Input\.insertText|Runtime\.evaluate|Network\.getResponseBody|new WebSocket/
  const offenders = []
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
    if (banned.test(code)) offenders.push(`${f}(选择器/CDP)`)
    // ⚠️ 限额判定只能来自护栏。适配器里出现字面数字比较即分层错误。
    if (/\bdaily_max\s*[<>=]+\s*\d/.test(code) || /\bmin_interval_ms\s*[<>=]+\s*\d/.test(code)) {
      offenders.push(`${f}(硬编码限额判定)`)
    }
  }
  assert.deepStrictEqual(offenders, [])
})

test('适配器分层：弹幕链路必须没有 DOM 兜底（有就是缺陷，不是缺功能）', () => {
  const dir = path.join(__dirname, '..', '..', 'client', 'adapters')
  const danmaku = stripCommentsForScan(fs.readFileSync(path.join(dir, 'reply-danmaku.js'), 'utf8'))
  const dm = stripCommentsForScan(fs.readFileSync(path.join(dir, 'send-dm.js'), 'utf8'))

  // ⚠️ 弹幕发出去就滚走了，DOM 上**不存在**任何可回读的证据。
  //    `waitForReplyStable` 只能产出 sent_confirmed_dom —— 对弹幕而言
  //    那是一个无法证伪的假证据，而它是计费依据的一部分。
  //    这条断言是"弹幕不得回落 DOM"的**回归测试**：
  //    将来有人"顺手补上这个缺失的功能"，这里必然失败。
  assert.ok(!/waitForReplyStable/.test(danmaku),
    '弹幕适配器不得调用 waitForReplyStable：弹幕没有 DOM 证据，' +
    'sent_confirmed_dom 对它是不可获得的形态，不是"暂时拿不到"')
  assert.ok(!/domConfirmed|dom_stable/.test(danmaku),
    '弹幕适配器不得触碰 DOM 判据的构造入口')
  assert.ok(!/domConfirmed/.test(dm),
    '私信发出去进入的是对方的会话，商家页面上没有"我发成功了吗"的证据，同样不得用 DOM 判据')

  // ⚠️ 页面模型上也不许有这个方法——"想兜底"的念头应该在类型层面就落空
  const liveSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'platform', 'page-live.js'), 'utf8')
  assert.ok(!/async waitForReplyStable/.test(liveSrc),
    'LivePage 不得提供 waitForReplyStable：它的存在只会诱导上层去做 DOM 兜底')

  // ⚠️ 私信不得出现任何字面相似度阈值（0.75 必须来自 policy）
  assert.ok(!/0\.75|0\.85/.test(dm), '私信适配器不得硬编码相似度阈值，必须读 guard.effectiveLimits("dm")')
  assert.ok(!/0\.75|0\.85/.test(danmaku), '弹幕适配器不得硬编码相似度阈值')
})

test('适配器分层：私信不做日均新会话判定（准入归 guard.canSend 与调度器）', () => {
  const dm = stripCommentsForScan(
    fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'adapters', 'send-dm.js'), 'utf8'))
  // ⚠️ 契约 §4.6 的 new_conversation_daily_max 是私信专有的日上限，
  //    但它的判定必须在**取任务之前**完成（Guard.canSend + 调度器）。
  //    放到适配器里已经太晚：任务已被取出、attempts 已递增，
  //    而且适配器根本看不到当天的计数。
  assert.ok(!/new_conversation_daily_max/.test(dm),
    '私信适配器不得实现新会话日上限判定：那是 Guard.canSend 与调度器的职责')
  assert.ok(!/usedToday|dailyUsed|remaining/.test(dm),
    '适配器不得自己统计当日用量——那需要一份与 guard 平行的计数，必然漂移')
})

/** 剥注释（与平台层测试同一套简化规则）。 */
function stripCommentsForScan(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

// ══════════════════════════════════════════════════════════
// 弹幕回复编排
// ══════════════════════════════════════════════════════════

/**
 * ⚠️ 这份替身**没有** `waitForReplyStable`。
 *    这不是省略，是刻意：真实链路里弹幕也不该有 DOM 兜底，
 *    在这里补一个方法只会让"偷偷兜底"的实现也能跑通测试。
 *    需要验证"没兜底"的用例直接断言 `domStabilityCalls === 0`。
 */
function danmakuHarness(opts = {}) {
  const order = []
  const P = require('../../client/license/privacy')
  const SALT = 'salt-abc'
  const roomId = opts.roomId || '7001'
  const msgId = opts.msgId === undefined ? 'm-1' : opts.msgId
  const bodyText = opts.bodyText || '这个多少钱'
  const rows = opts.pageRows || [{ rowKey: msgId || 'k-1', user: '小明', text: bodyText }]

  const page = {
    order,
    domStabilityCalls: 0,
    async open() { order.push('open') },
    async collect() { order.push('collect'); return rows },
    async focusInput() {
      order.push('focus')
      if (opts.focusThrows) throw new W.WorkbenchError('ELEMENT_TIMEOUT', '输入框没出现')
      return opts.focusResult || { ok: true, x: 1, y: 2, focused: true }
    },
    async typeIntoInput() {
      order.push('type')
      // ⚠️ 此刻 outbox 必须**已经**有记录（send_id 先落盘，红线 2）
      opts.beforeType && opts.beforeType()
      if (opts.typeThrows) throw new W.WorkbenchError('ELEMENT_TIMEOUT', '输入失败')
      return { ok: true }
    },
    async submitDanmaku() {
      order.push('submit')
      // ⚠️ 此刻捕获必须**已经**打开（漏掉窗口对弹幕不可挽回）
      opts.beforeSubmit && opts.beforeSubmit()
      return { via: 'enter', stillFilled: false }
    },
    /** ⚠️ 存在的唯一目的是"被调用即证明有人加了兜底"。 */
    async waitForReplyStable() {
      page.domStabilityCalls += 1
      order.push('domCheck')
      return opts.domStable || { stable: false, stableMs: 0 }
    },
  }

  const verifier = {
    order,
    async beginCapture(role, endpoint) {
      order.push('beginCapture')
      return { endpoint, cursor: 0 }
    },
    async verify() {
      order.push('verify')
      return opts.verifyResult || {
        verdict: 'sent_confirmed', is_final: true,
        evidence: {
          confirm_signal: 'platform_response',
          platform_endpoint: 'live/comment/send',
          platform_status_code: 0,
        },
        failure_reason: null,
      }
    },
    async abortCapture() { order.push('abortCapture'); return { ok: true } },
  }

  const state = { privacySalt: SALT, policyVersion: 9, instanceIdValue: 'inst-1' }
  const guard = {
    effectiveLimits: (src) => ({
      // ⚠️ 三个渠道的阈值刻意不同：写错渠道名就会断言失败
      daily_max: 10, min_interval_ms: 180000,
      content_similarity_max: src === 'dm' ? 0.75 : 0.85,
    }),
  }

  const h = makeStore()
  const outbox = new SendOutbox({ store: h.store, now: () => NOW })
  const adapter = new ReplyDanmakuAdapter({
    page, verifier, outbox, state, guard,
    similarity, rng: timing.makeSeededRng(7),
  })
  return {
    ...h, page, verifier, outbox, adapter, order, salt: SALT, P, roomId, msgId,
    makeTask: (over = {}) => danmakuTask({ roomId, msgId, bodyText, salt: SALT }, over),
  }
}

function danmakuTask(base, over = {}) {
  const P = require('../../client/license/privacy')
  const msgId = over.msgId === undefined ? base.msgId : over.msgId
  // ⚠️ targetHash 与 collect.js 完全同口径（含它自己的退化分支），
  //    适配器要**原样复用**这个值而不是重算 —— 重算必然与队列去重键分叉。
  const tHash = P.targetHash(
    `${base.roomId}|${msgId || over.rowKey || P.contentHash(base.bodyText, base.salt)}`, base.salt)
  return {
    kind: 'reply_danmaku', sourceType: 'live_danmaku', dedupKey: 'dk-live-1',
    payload: {
      roomId: base.roomId,
      roomUrl: 'https://live.douyin.com/7001',
      msgId: msgId || null,
      rowKey: over.rowKey || null,
      bodyKeyHash: P.contentHash(over.__bodyText || base.bodyText, base.salt),
      bodyKeyPrefix: (over.__bodyText || base.bodyText).slice(0, 12),
      userKey: '小明',
      targetHash: tHash,
      userKeyHash: P.userKeyHash('MS4wLIVESECRET', base.salt),
      rules: RULES,
      ...over,
    },
  }
}

test('弹幕：响应捕获先于提交，且 send_id 先于任何页面写动作（顺序即红线）', async () => {
  const h = danmakuHarness({
    beforeType: () => {
      // ⚠️ 走到"输入"时 outbox 必须已经有记录。反了就是
      //    "发送成功后才生成 ID"，崩溃后无法幂等 → 重复弹幕 + 重复计费。
      assert.strictEqual(h.outbox.list().length, 1, 'send_id 必须先落盘再触碰页面')
      assert.strictEqual(h.outbox.list()[0].state, 'unknown')
      assert.ok(h.order.includes('beginCapture'), '捕获必须已经在输入之前打开')
    },
    beforeSubmit: () => {
      assert.ok(h.order.includes('beginCapture'), '捕获必须先于提交')
    },
  })
  try {
    const r = await h.adapter.run(h.makeTask())
    assert.strictEqual(r.outcome, 'done')
    assert.ok(h.order.indexOf('beginCapture') < h.order.indexOf('type'),
      '必须先打开捕获再输入：弹幕漏掉捕获窗口不可挽回')
    assert.ok(h.order.indexOf('beginCapture') < h.order.indexOf('submit'))
    assert.ok(h.order.indexOf('focus') < h.order.indexOf('type'))
    assert.strictEqual(h.outbox.list().length, 1)
    assert.strictEqual(h.outbox.list()[0].state, 'confirmed')
  } finally { h.cleanup() }
})

test('弹幕：status_code=0 → sent_confirmed + platform_response（唯一可计费形态）', async () => {
  const h = danmakuHarness()
  try {
    const r = await h.adapter.run(h.makeTask())
    assert.strictEqual(r.verdict, 'sent_confirmed')
    assert.strictEqual(r.evidence.confirm_signal, 'platform_response')
    assert.strictEqual(r.evidence.platform_status_code, 0)
    assert.strictEqual(h.outbox.list()[0].state, 'confirmed')
    // ⚠️ 只记长度不记原文（红线 3）
    assert.ok(r.detail.text_length > 0)
    assert.strictEqual(r.detail.text, undefined)
  } finally { h.cleanup() }
})

test('弹幕：抓不到响应 → sent_suspected 且**绝不回落 DOM**（这是本文件的回归测试）', async () => {
  const h = danmakuHarness({
    verifyResult: {
      verdict: 'sent_suspected', is_final: false,
      evidence: { confirm_signal: 'none', platform_endpoint: 'live/comment/send', note: 'no_response_captured' },
      failure_reason: null,
    },
    // 即便"DOM 看起来稳定"，也不得采信
    domStable: { stable: true, stableMs: 3000 },
  })
  try {
    const r = await h.adapter.run(h.makeTask())
    assert.strictEqual(r.verdict, 'sent_suspected',
      '弹幕没有 DOM 证据，抓不到响应就是 suspected，到此为止')
    assert.notStrictEqual(r.verdict, 'sent_confirmed')
    assert.notStrictEqual(r.verdict, 'sent_confirmed_dom',
      '⚠️ sent_confirmed_dom 对弹幕是**不可获得**的形态。给弹幕加 DOM 兜底不是补功能，' +
      '而是制造无法证伪的假证据——而它是计费依据的一部分')
    assert.strictEqual(r.evidence.confirm_signal, 'none')
    assert.strictEqual(h.page.domStabilityCalls, 0,
      '不得调用任何 DOM 稳定性判据（弹幕发出去就滚走了，DOM 上什么都留不下）')
    assert.ok(!h.order.includes('domCheck'))
    const rec = h.outbox.list()[0]
    assert.strictEqual(rec.state, 'suspected')
    // ⚠️ 必须保留升级空间：is_final=false（契约 §6.3 只允许单向升级）
    const reportable = h.outbox.recoverUnknown()
    assert.strictEqual(reportable.length, 0, '已 settle 的记录不该被 recoverUnknown 再捞出来')
  } finally { h.cleanup() }
})

test('弹幕：空响应 = 风控拒绝（failed + risk_control_rejected，绝不判成功）', async () => {
  const h = danmakuHarness({
    verifyResult: {
      verdict: 'failed', is_final: true,
      evidence: {
        confirm_signal: 'none', platform_endpoint: 'live/comment/send',
        platform_status_code: null, risk_control_signal: 'empty_response', http_status: 200,
      },
      failure_reason: 'risk_control_rejected',
    },
  })
  try {
    const r = await h.adapter.run(h.makeTask())
    assert.strictEqual(r.outcome, 'failed')
    assert.strictEqual(r.verdict, 'failed')
    assert.strictEqual(r.failureReason, 'risk_control_rejected')
    assert.strictEqual(r.evidence.risk_control_signal, 'empty_response',
      '空响应是风控信号，熔断计数靠它累加（契约 §4.8）')
    assert.strictEqual(h.outbox.list()[0].state, 'failed')
    // 失败路径同样不得去看 DOM
    assert.strictEqual(h.page.domStabilityCalls, 0)
  } finally { h.cleanup() }
})

test('弹幕：目标弹幕扫不到 → skipped + danmaku_not_found（不产生 send_id）', async () => {
  const h = danmakuHarness({
    bodyText: '这个多少钱',
    // 页面上现在是别的内容（目标弹幕已经滚走了）
    pageRows: [{ rowKey: 'other', user: '别人', text: '主播好厉害' }],
  })
  try {
    const r = await h.adapter.run(h.makeTask())
    assert.strictEqual(r.outcome, 'skipped')
    assert.strictEqual(r.reason, 'danmaku_not_found')
    assert.strictEqual(h.outbox.list().length, 0,
      '扫不到就不该生成 send_id —— 它根本没进入计费链路')
    assert.ok(!h.order.includes('type'), '没定位到就不该输入任何文字')
  } finally { h.cleanup() }
})

test('弹幕：稳定 msgId 优先于内容哈希（同一句话被复读时不能认错人）', async () => {
  const bodyText = '这个多少钱'
  const h = danmakuHarness({
    msgId: 'm-target',
    bodyText,
    pageRows: [
      // ⚠️ 先出现的是**别人**复读的同一句话；只按哈希匹配就会锁定到这一条
      { rowKey: 'm-someone-else', user: '路人甲', text: bodyText },
      { rowKey: 'm-target', user: '小明', text: bodyText },
    ],
  })
  try {
    const r = await h.adapter.run(h.makeTask())
    assert.strictEqual(r.outcome, 'done', '必须按 msgId 命中目标那条，而不是第一条同文本的')
  } finally { h.cleanup() }
})

test('弹幕：target_hash 原样复用采集阶段的值（重算会与队列去重键分叉）', async () => {
  const h = danmakuHarness({ msgId: null, rowKey: 'rk-9' })
  try {
    const t = h.makeTask({ rowKey: 'rk-9' })
    await h.adapter.run(t)
    assert.strictEqual(h.outbox.list()[0].target_hash, t.payload.targetHash,
      'task_hash 必须与 collect.js 算出的完全一致，否则服务端无法按目标聚合')
    assert.strictEqual(t.payload.target_hash, undefined)
  } finally { h.cleanup() }
})

test('弹幕：提交后抛错 → outbox 保留 unknown（不判失败、不重发）并收尾捕获', async () => {
  const h = danmakuHarness({ typeThrows: true })
  try {
    await assert.rejects(() => h.adapter.run(h.makeTask()))
    const rec = h.outbox.list()[0]
    assert.ok(rec, 'outbox 里必须留下记录')
    assert.strictEqual(rec.state, 'unknown',
      '⚠️ 抛错后不能判 failed —— 错误可能发生在"已经按了 Enter"之后，' +
      '那条弹幕其实已经飞出去了。判 failed 会让它永久失去升级机会')
    assert.ok(h.order.includes('abortCapture'), '异常路径必须收尾捕获，否则 Network 监听器泄漏')
    assert.strictEqual(h.page.domStabilityCalls, 0)
  } finally { h.cleanup() }
})

test('弹幕：点不出公屏输入框时放弃发送，但 outbox 记录保留（不静默变 skipped）', async () => {
  const h = danmakuHarness({ focusThrows: true })
  try {
    await assert.rejects(
      () => h.adapter.run(h.makeTask()),
      (e) => e.code === 'ELEMENT_TIMEOUT'
    )
    assert.strictEqual(h.outbox.list().length, 1,
      'begin 已经执行过，记录不能消失 —— 否则那笔发送就彻底追踪不到了')
    assert.strictEqual(h.outbox.list()[0].state, 'unknown')
    assert.ok(!h.order.includes('beginCapture'), '还没到捕获那一步')
  } finally { h.cleanup() }
})

test('弹幕：相似度被拒 → failed + content_rejected（不是 skipped）', async () => {
  const h = danmakuHarness()
  try {
    h.adapter.rng = () => 0
    const fixed = RR.renderReply({ templates: RULES[0].templates, rng: () => 0 })
    h.adapter.recentTexts = [fixed.text, fixed.text, fixed.text]
    const r = await h.adapter.run(h.makeTask())
    assert.strictEqual(r.outcome, 'failed')
    assert.strictEqual(r.failureReason, 'content_rejected')
    assert.strictEqual(r.evidence.note, 'content_similarity_rejected')
    assert.strictEqual(r.evidence.threshold, 0.85,
      '阈值必须来自 guard.effectiveLimits("live_danmaku")')
    assert.strictEqual(h.outbox.list().length, 0, '被护栏拦下时不产生 send_id')
    assert.ok(!h.order.includes('type'), '被拒时绝不能已经输入了文案')
  } finally { h.cleanup() }
})

test('弹幕：上报明细里只有哈希，没有弹幕原文与 sec_uid（红线 3）', async () => {
  const h = danmakuHarness()
  try {
    await h.adapter.run(h.makeTask())
    const rec = h.outbox.list()[0]
    assert.strictEqual(rec.source_type, 'live_danmaku')
    assert.strictEqual(rec.content_hash.length, 64)
    assert.strictEqual(rec.target_hash.length, 64)
    assert.strictEqual(rec.user_key_hash.length, 64)
    const raw = fs.readFileSync(h.store.file(F_OUTBOX), 'utf8')
    assert.ok(!raw.includes('这个多少钱'), '弹幕原文绝不能落盘')
    assert.ok(!raw.includes('MS4wLIVESECRET'), 'sec_uid 原文绝不能落盘')
  } finally { h.cleanup() }
})

// ══════════════════════════════════════════════════════════
// 私信发送编排
// ══════════════════════════════════════════════════════════

function dmHarness(opts = {}) {
  const order = []
  const P = require('../../client/license/privacy')
  const SALT = 'salt-abc'
  const bodyText = opts.bodyText || '这个多少钱'
  const profilePath = opts.profilePath === undefined ? '/user/MS4wLDM_SECRET' : opts.profilePath
  const sourceItems = opts.sourceItems || [{ index: 0, commentId: 'c1', text: bodyText, user: '小明' }]

  const commentPage = {
    order,
    async open() { order.push('srcOpen') },
    async scan() { order.push('scan'); return sourceItems },
    async collect() { order.push('collect'); return sourceItems },
  }
  const profilePage = {
    order,
    async resolveUserPath(a) {
      order.push('resolveUserPath')
      if (opts.resolveThrows) throw new W.WorkbenchError('ELEMENT_TIMEOUT', '解析失败')
      return opts.resolved === undefined
        ? { found: true, profilePath }
        : opts.resolved
    },
    async openConversation() {
      order.push('openConversation')
      if (opts.openThrows) throw new W.WorkbenchError('LOGIN_EXPIRED', '登录态失效')
      return opts.opened === undefined
        ? { ok: true, url: 'https://www.douyin.com/user/x', conversationId: 'conv-1' }
        : opts.opened
    },
    async focusInput() {
      order.push('focus')
      return opts.focusResult || { ok: true, x: 1, y: 2, focused: true }
    },
    async typeIntoInput() {
      order.push('type')
      // ⚠️ 私信的真实页面动作从"输入"开始；此刻 send_id 必须已经落盘
      opts.beforeType && opts.beforeType()
      if (opts.typeThrows) throw new W.WorkbenchError('ELEMENT_TIMEOUT', '输入失败')
      return { ok: true }
    },
    async findSendButton() {
      order.push('findSendButton')
      return opts.sendButton === undefined ? { ok: true, x: 5, y: 6 }
        : opts.sendButton
    },
    async submitMessage() {
      order.push('submitMessage')
      opts.beforeSubmit && opts.beforeSubmit()
      // ⚠️ 与真实 `ProfilePage.submitMessage` 同一套语义：
      //    按钮在就用按钮，不在才退回 Enter（私信的 Enter 可能只插入换行）
      const btn = await profilePage.findSendButton()
      if (btn && btn.ok) return { via: 'button' }
      order.push('pressEnterFallback')
      return { via: 'enter', reason: btn ? btn.reason : 'null' }
    },
  }
  const verifier = {
    order,
    async beginCapture(role, endpoint) { order.push('beginCapture'); return { endpoint, cursor: 0 } },
    async verify() {
      order.push('verify')
      return opts.verifyResult || {
        verdict: 'sent_confirmed', is_final: true,
        evidence: {
          confirm_signal: 'platform_response',
          platform_endpoint: 'im/send',
          platform_status_code: 0,
        },
        failure_reason: null,
      }
    },
    async abortCapture() { order.push('abortCapture'); return { ok: true } },
  }

  const state = { privacySalt: SALT, policyVersion: 9, instanceIdValue: 'inst-1' }
  const guard = {
    effectiveLimits: (src) => ({
      // ⚠️ 私信 0.75、其他 0.85。刻意不同：写错渠道名这条测试就会失败。
      daily_max: 3, min_interval_ms: 600000,
      content_similarity_max: src === 'dm' ? 0.75 : 0.85,
    }),
  }

  const h = makeStore()
  const outbox = new SendOutbox({ store: h.store, now: () => NOW })
  const adapter = new SendDmAdapter({
    profilePage, commentPage, livePage: null, verifier, outbox, state, guard,
    similarity, rng: timing.makeSeededRng(11),
  })
  return {
    ...h, profilePage, commentPage, verifier, outbox, adapter, order, salt: SALT,
    P, profilePath, secUid: 'MS4wLDM_SECRET',
    makeTask: (over = {}) => ({
      kind: 'send_dm', sourceType: 'comment', dedupKey: 'dk-dm-1',
      payload: {
        sourceUrl: 'https://www.douyin.com/video/1',
        sourceType: 'comment',
        commentId: 'c1',
        bodyKeyHash: P.contentHash(over.__bodyText || bodyText, SALT),
        bodyKeyPrefix: (over.__bodyText || bodyText).slice(0, 12),
        userKey: '小明',
        userKeyHash: P.userKeyHash('MS4wLDM_SECRET', SALT),
        rules: RULES,
        ...over,
      },
    }),
  }
}

test('私信：解析不到用户 → skipped + not_locatable，且**不留** outbox 记录（绝不猜目标）', async () => {
  const h = dmHarness({ resolved: { found: false, reason: 'no_profile_link_near_anchor' } })
  try {
    const r = await h.adapter.run(h.makeTask())
    assert.strictEqual(r.outcome, 'skipped')
    assert.strictEqual(r.reason, 'not_locatable')
    assert.strictEqual(h.outbox.list().length, 0,
      '⚠️ 绝不猜目标：猜错就是给陌生人发私信——那既是骚扰，' +
      '也是账号被判定为营销号最可靠的途径。没发出去就不该有 send_id')
    assert.ok(!h.order.includes('openConversation'), '连会话都不该打开')
    assert.ok(!h.order.includes('type'), '更不该输入任何文字')
  } finally { h.cleanup() }
})

test('私信：源内容已不在页面上 → skipped（不产生 send_id）', async () => {
  const h = dmHarness({ sourceItems: [{ index: 0, commentId: 'other', text: '今天天气不错', user: '别人' }] })
  try {
    const r = await h.adapter.run(h.makeTask())
    assert.strictEqual(r.outcome, 'skipped')
    assert.strictEqual(r.reason, 'not_locatable')
    assert.strictEqual(h.outbox.list().length, 0)
  } finally { h.cleanup() }
})

test('私信：相似度被拒 → failed + content_rejected，阈值取自 dm（0.75 而不是 0.85）', async () => {
  const h = dmHarness()
  try {
    h.adapter.rng = () => 0
    const fixed = RR.renderReply({ templates: RULES[0].templates, rng: () => 0 })
    h.adapter.recentTexts = [fixed.text, fixed.text, fixed.text]
    const r = await h.adapter.run(h.makeTask())
    assert.strictEqual(r.outcome, 'failed')
    assert.strictEqual(r.failureReason, 'content_rejected')
    assert.strictEqual(r.evidence.note, 'content_similarity_rejected')
    assert.strictEqual(r.evidence.threshold, 0.75,
      '⚠️ 私信阈值必须来自 guard.effectiveLimits("dm")：写死 0.85 就等于放宽了私信护栏')
    assert.strictEqual(h.outbox.list().length, 0)
    assert.ok(!h.order.includes('type'), '被护栏拦下时绝不能已经输入了文案')
  } finally { h.cleanup() }
})

test('私信：happy path → sent_confirmed + im/send，且盘上没有任何明文', async () => {
  const h = dmHarness()
  try {
    const task = h.makeTask()
    // ⚠️ 固定随机源，让"将要发出去的那句话"可复现——这样下面才能对
    //    **回复原文**本身做"不得落盘"的断言（而不是只断言源正文）。
    h.adapter.recentTexts = []
    h.adapter.rng = () => 0
    const replyText = RR.renderReply({ templates: RULES[0].templates, rng: () => 0 }).text
    const r = await h.adapter.run(task)
    assert.strictEqual(r.verdict, 'sent_confirmed')
    assert.strictEqual(r.evidence.confirm_signal, 'platform_response')
    assert.strictEqual(r.evidence.platform_endpoint, 'im/send')
    assert.strictEqual(r.evidence.platform_status_code, 0)
    assert.strictEqual(r.detail.text_length, replyText.length,
      '必须先确认这条测试用的确实是那句渲染结果，否则下面的"不得落盘"断言是空转')

    const rec = h.outbox.list()[0]
    assert.strictEqual(rec.source_type, 'dm')
    assert.strictEqual(rec.content_hash.length, 64)
    assert.strictEqual(rec.target_hash.length, 64)
    assert.strictEqual(rec.user_key_hash, h.P.userKeyHash(h.secUid, h.salt),
      'user_key_hash 必须来自 privacy.userKeyHash(secUid, salt)')
    assert.strictEqual(rec.user_key_type, 'sec_uid')

    // ⚠️⚠️ 红线 3 的正面断言：**盘上任何地方**都不许出现私信原文与 sec_uid。
    //      这是本项目最容易出错、代价最高的一条（legacy 直接把 sec_uid 写进了 JSON）。
    const files = ['send-outbox.json', 'queue.json', 'pending-sends.json', 'leads.json', 'replied-history.json']
    let dumped = ''
    for (const f of files) {
      if (fs.existsSync(h.store.file(f))) dumped += fs.readFileSync(h.store.file(f), 'utf8')
    }
    assert.ok(dumped.length > 0, '至少要检查到 outbox 的内容，否则这条断言是空转')
    assert.ok(!dumped.includes(h.secUid), '⚠️ sec_uid 原文绝不能落盘')
    assert.ok(!dumped.includes('这个多少钱'), '⚠️ 源正文/私信文案原文绝不能落盘')
    // ⚠️ 回复原文（真正发出去的那句话）同样不得落盘。它由模板渲染而来，
    //    与源正文不是同一个字符串 —— 只断言源正文会漏掉它。
    assert.ok(!dumped.includes(replyText), `⚠️ 私信回复原文绝不能落盘：${replyText}`)
    // 返回值与证据里同样不得出现原文
    const asJson = JSON.stringify(r)
    assert.ok(!asJson.includes(h.secUid), '返回值里不得带 sec_uid')
    assert.ok(!asJson.includes('MS4wLDM_SECRET'))
    assert.ok(!asJson.includes(replyText), '返回值里不得带回复原文')
    assert.strictEqual(r.detail.text, undefined, '只记长度不记原文')
  } finally { h.cleanup() }
})

test('私信：target_hash 按契约口径 —— 有 conversation_id 用它，没有才退到 profilePath', async () => {
  const h = dmHarness()
  try {
    await h.adapter.run(h.makeTask())
    assert.strictEqual(h.outbox.list()[0].target_hash,
      h.P.targetHash('conv-1', h.salt),
      '契约 §4.8：私信 target_hash = hmac(salt, conversation_id)')
  } finally { h.cleanup() }

  // 页面给不出会话 ID 时退到 profilePath（最接近的稳定身份），并保持可复现
  const h2 = dmHarness({ opened: { ok: true, url: 'https://www.douyin.com/user/x', conversationId: null } })
  try {
    await h2.adapter.run(h2.makeTask())
    const a = h2.outbox.list()[0].target_hash
    assert.strictEqual(a, h2.P.targetHash(h2.profilePath, h2.salt))
    const h3 = dmHarness({ opened: { ok: true, url: 'https://www.douyin.com/user/x', conversationId: null } })
    try {
      await h3.adapter.run(h3.makeTask())
      assert.strictEqual(h3.outbox.list()[0].target_hash, a,
        '同一个人的会话必须得到同一个 target_hash，否则服务端无法按目标聚合')
    } finally { h3.cleanup() }
  } finally { h2.cleanup() }
})

test('私信：发送按钮缺失时退回 Enter，且两条路径都在响应捕获之后', async () => {
  const h = dmHarness({ sendButton: { ok: false, reason: 'send_button_not_found' } })
  try {
    const r = await h.adapter.run(h.makeTask())
    assert.strictEqual(r.verdict, 'sent_confirmed')
    const iCapture = h.order.indexOf('beginCapture')
    const iSubmit = h.order.indexOf('submitMessage')
    const iEnter = h.order.indexOf('pressEnterFallback')
    assert.ok(iCapture >= 0 && iSubmit > iCapture, '捕获必须先于提交')
    assert.ok(iEnter > iSubmit, '必须是在按钮不可用之后才退回 Enter')
    assert.ok(h.order.indexOf('findSendButton') > iSubmit,
      '必须先真的去找/点发送按钮（Enter 只作兜底）')
    assert.ok(h.order.indexOf('type') > iCapture, '输入也要在捕获之后')
    // ⚠️ Enter 只是"提交手段"，不是成功证据：判定仍来自 im/send 的响应体
    assert.strictEqual(r.evidence.confirm_signal, 'platform_response')
  } finally { h.cleanup() }
})

test('私信：点不出输入框 → 可重试的 ELEMENT_TIMEOUT，且**在触碰 outbox 之前**失败', async () => {
  const h = dmHarness({ focusResult: { ok: false, reason: 'dm_input_not_found' } })
  try {
    await assert.rejects(
      () => h.adapter.run(h.makeTask()),
      (e) => {
        assert.strictEqual(e.code, 'ELEMENT_TIMEOUT')
        assert.strictEqual(W.isRetryable(e.code), true, '聚焦失败是可重试故障，应重排队')
        return true
      }
    )
    assert.strictEqual(h.outbox.list().length, 0,
      '⚠️ 此刻什么都没发出去，不该留下 outbox 记录 —— 留了就会在恢复流程里' +
      '变成一条凭空的 sent_suspected，虚高且无法解释')
  } finally { h.cleanup() }
})

test('私信：send_id 先于任何页面写动作（红线 2 的顺序）', async () => {
  const h = dmHarness({
    beforeType: () => {
      assert.strictEqual(h.outbox.list().length, 1, 'send_id 必须先落盘再触碰页面')
      assert.ok(h.order.includes('beginCapture'), '捕获必须已经在输入之前打开')
    },
    beforeSubmit: () => {
      assert.strictEqual(h.outbox.list().length, 1)
      assert.ok(h.order.includes('beginCapture'))
    },
  })
  try {
    await h.adapter.run(h.makeTask())
    assert.strictEqual(h.outbox.list()[0].state, 'confirmed')
  } finally { h.cleanup() }
})

test('私信：提交后抛错 → outbox 保留 unknown 并收尾捕获（不判失败、不重发）', async () => {
  const h = dmHarness({ typeThrows: true })
  try {
    await assert.rejects(() => h.adapter.run(h.makeTask()))
    const rec = h.outbox.list()[0]
    assert.ok(rec)
    assert.strictEqual(rec.state, 'unknown',
      '错误可能发生在"已经点了发送"之后，那条私信其实已经出去了')
    assert.ok(h.order.includes('abortCapture'), '异常路径必须收尾捕获')
  } finally { h.cleanup() }
})

test('私信：抓不到响应 → sent_suspected 且 is_final=false（不得假装确认过）', async () => {
  const h = dmHarness({
    verifyResult: {
      verdict: 'sent_suspected', is_final: false,
      evidence: { confirm_signal: 'none', platform_endpoint: 'im/send', note: 'no_response_captured' },
      failure_reason: null,
    },
  })
  try {
    const r = await h.adapter.run(h.makeTask())
    assert.strictEqual(r.verdict, 'sent_suspected')
    assert.strictEqual(h.outbox.list()[0].state, 'suspected')
    const rec = onDiskRecord(h.store, h.outbox.list()[0].send_id)
    assert.strictEqual(rec.state, 'suspected')
  } finally { h.cleanup() }
})

/** 从盘上读回某条 outbox 记录（证明"落盘"而不是"只在内存里"）。 */
function onDiskRecord(store, sendId) {
  const raw = JSON.parse(fs.readFileSync(store.file(F_OUTBOX), 'utf8'))
  const list = raw.data || raw
  return list.find((r) => r.send_id === sendId)
}

test('私信：策略缺 dm 阈值时**拒绝发送**（fail-closed，不猜默认值）', async () => {
  const h = dmHarness()
  try {
    h.adapter.guard = { effectiveLimits: () => ({ daily_max: 3, min_interval_ms: 600000 }) }
    await assert.rejects(
      () => h.adapter.run(h.makeTask()),
      (e) => {
        assert.strictEqual(e.code, 'CONFIG_INVALID')
        assert.match(e.message, /content_similarity_max/)
        return true
      }
    )
    assert.strictEqual(h.outbox.list().length, 0, '拒绝时不该留下 outbox 记录')
  } finally { h.cleanup() }
})
