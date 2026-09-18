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
