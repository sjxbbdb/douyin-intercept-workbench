'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { parse } = require('../lib/mini-dom.js')
const selectors = require('../../client/platform/selectors.js')

const FIXTURES = path.join(__dirname, '..', 'fixtures')
function load(name) {
  const file = path.join(FIXTURES, name)
  assert.ok(fs.existsSync(file), `缺少 fixture：${name}（见 shared/测试策略.md §2.3）`)
  return parse(fs.readFileSync(file, 'utf8'))
}

// 与运行期同源的「取可见根」判定——离线版读录制标记，运行期读 getBoundingClientRect
function pickRoot(doc, entry) {
  const all = doc.querySelectorAll(entry.candidates[0])
  if (entry.match === 'first-visible') {
    // ⚠️ 离线用录制期标记代替布局判定（局限见 §2.6）
    return all.find((el) => el.getAttribute('data-fixture-visible') === '1') || null
  }
  if (entry.match === 'first') return all[0] || null
  return all
}

// ---------- 1. 注册表自身完整性 ----------
test('selectors.js：每个条目都带齐硬性字段', () => {
  const REQUIRED = ['key', 'name', 'channel', 'candidates', 'match', 'required',
                    'lastVerifiedAt', 'liveVerifiedAt', 'confidence', 'fixture', 'notes']
  for (const [k, e] of Object.entries(selectors)) {
    assert.strictEqual(e.key, k, `key 与导出名不一致：${k}`)
    for (const f of REQUIRED) assert.ok(f in e, `${k} 缺少字段 ${f}`)
    assert.ok(Array.isArray(e.candidates) && e.candidates.length > 0, `${k} 的 candidates 必须是非空数组`)

    // lastVerifiedAt = 离线 fixture 回归验证日期（可自动复跑，必须已填）
    assert.match(e.lastVerifiedAt, /^\d{4}-\d{2}-\d{2}$/, `${k} 的 lastVerifiedAt 必须是 ISO 日期`)

    // liveVerifiedAt = 真机验证日期（P2 验证门 G-4）。未验证时必须为 null，
    // ⚠️ 不得为了"看起来完成"而填入日期 —— 见 AGENTS.md §6 完成定义。
    assert.ok(e.liveVerifiedAt === null || /^\d{4}-\d{2}-\d{2}$/.test(e.liveVerifiedAt),
      `${k} 的 liveVerifiedAt 必须为 null（未验证）或 ISO 日期`)

    assert.ok(['high', 'medium', 'low'].includes(e.confidence), `${k} 的 confidence 非法`)

    // 标为 high 的条目必须有离线 fixture 支撑（见平台知识 §6.2）
    if (e.confidence === 'high') {
      assert.ok(e.fixture && fs.existsSync(path.join(FIXTURES, e.fixture)), `${k} 标为 high 但无对应 fixture`)
    }
  }
})

// ---------- 1b. 真机验证状态可见性 ----------
// 本测试不阻止交付，但把"尚未真机验证"的事实显式暴露出来，
// 避免下游误以为选择器已可用。
test('selectors.js：真机验证状态（信息性）', () => {
  const entries = Object.values(selectors)
  const unverified = entries.filter((e) => e.liveVerifiedAt === null).map((e) => e.key)
  if (unverified.length > 0) {
    console.log(`  ℹ️ 尚未真机验证的选择器 ${unverified.length}/${entries.length}：${unverified.join(', ')}`)
    console.log('     → P2 验证门 G-4 通过后逐条回填 liveVerifiedAt 与 verifiedBy')
  }
  assert.ok(true)
})

// ---------- 2. 视频页：评论区必须命中「可见」的那一个 ----------
test('video-page：commentList 命中可见根（而非隐藏的那一套）', () => {
  const doc = load('video-page-desktop-01.html')
  const entry = selectors.commentList
  const all = doc.querySelectorAll(entry.candidates[0])
  assert.ok(all.length >= 2, '⚠️ 该 fixture 应含隐藏+可见两套 comment-list；若只剩 1 个说明快照录错了')

  const root = pickRoot(doc, entry)
  assert.ok(root, '未找到可见的 comment-list → 可见性判定逻辑已失效，真机上会拿到 0×0 按钮')

  // 反例保护：隐藏的那个必须被排除
  const hidden = all.find((el) => el.getAttribute('data-fixture-visible') === '0')
  assert.ok(hidden, 'fixture 中应有标记为隐藏的一套，否则本用例没有验证价值')
  assert.notStrictEqual(root, hidden, '⚠️ 选中了隐藏的 comment-list，这是已知最贵的坑')
})

test('video-page：commentItem / commentContent 在可见根内可命中', () => {
  const doc = load('video-page-desktop-01.html')
  const root = pickRoot(doc, selectors.commentList)
  const items = root.querySelectorAll(selectors.commentItem.candidates[0])
  assert.ok(items.length > 0, '可见根内没有 comment-item')

  const withContent = items.filter((it) => it.querySelectorAll(selectors.commentContent.candidates[0]).length > 0)
  assert.ok(withContent.length > 0, '没有任何 comment-item 含 comment-content')
})

// ---------- 3. 回复按钮：可见 + 文案严格等于「回复」 ----------
test('video-page：回复按钮可定位，且候选唯一性可判定', () => {
  const doc = load('video-page-desktop-01.html')
  const root = pickRoot(doc, selectors.commentList)
  const items = root.querySelectorAll(selectors.commentItem.candidates[0])

  let hits = 0
  for (const item of items) {
    const cands = item.querySelectorAll(selectors.replyButton.candidates[0])
      .filter((e) => (e.innerText || '').replace(/\s+/g, '').trim() === '回复')
      // ⚠️ 必须排除弹幕的「回复」（见平台知识 §1.4）
      .filter((e) => !String(e.getAttribute('class') || '').includes('danmaku'))
    hits += cands.length
  }
  assert.ok(hits > 0, '⚠️ 回复按钮未命中：抖音很可能改了按钮结构或文案')
})

// ---------- 4. 内联编辑器与「回复中」标记 ----------
test('video-page：处于回复态的评论项内含 contenteditable', () => {
  const doc = load('video-page-desktop-01.html')
  const root = pickRoot(doc, selectors.commentList)
  const items = root.querySelectorAll(selectors.commentItem.candidates[0])
  const inReplyMode = items.filter((it) => (it.innerText || '').includes('回复中'))
  assert.ok(inReplyMode.length > 0, '⚠️ 未找到含「回复中」的评论项：内联编辑器的激活判据已失效')
  const editors = inReplyMode.flatMap((it) => it.querySelectorAll(selectors.inlineEditor.candidates[0]))
  assert.ok(editors.length > 0, '回复态评论项内没有 [contenteditable=true]')
})

// ---------- 5. 图文帖：必须能识别出「不支持」而不是硬试 ----------
test('note-page：能被 note 帖判定表达式识别', () => {
  const doc = load('note-page-desktop-01.html')
  const hit = doc.querySelectorAll('div.note-detail-container').length > 0
  assert.ok(hit, '⚠️ note 帖识别失效：会把平台布局差异当成失败刷屏（见平台知识 §1.3）')
})

// ---------- 6. 直播弹幕：解析规则必须能产出「昵称 + 正文」两行 ----------
test('live-room：弹幕行可解析出昵称与正文', () => {
  const doc = load('live-room-desktop-01.html')
  const rows = doc.querySelectorAll(selectors.danmakuRow.candidates[0])
  assert.ok(rows.length > 0, '⚠️ 弹幕行未命中：7 个模糊选择器里至少有一个已失效')

  const parsed = rows.map((r) => (r.innerText || '').split(/\n+/).map((s) => s.trim()).filter(Boolean))
    .filter((lines) => lines.length >= 2)
  assert.ok(parsed.length > 0, '没有任何弹幕行能解析出「昵称 + 正文」两行')

  // ⚠️ 噪音过滤必须生效（见平台知识 §4.2）
  const NOISE = /^(进入直播间|加入了直播间|点赞了|关注了主播|分享了直播间|送出|赠送|来了|拍了拍)/
  const noiseRows = parsed.filter((l) => NOISE.test(l.slice(1).join(' ')))
  assert.ok(noiseRows.length > 0, 'fixture 中应有噪音行，否则解析测试没有验证价值')
})

// ---------- 7. 脱敏门禁：fixture 不得含隐私残留 ----------
test('fixtures：脱敏门禁（无真实用户数据）', () => {
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.html'))
  assert.ok(files.length > 0, 'fixtures 目录为空——P0 的必要产出缺失')
  for (const f of files) {
    const html = fs.readFileSync(path.join(FIXTURES, f), 'utf8')
    // 只做「强烈信号」检查；完整规则见 §7.1
    assert.ok(!/1[3-9]\d{9}/.test(html), `${f} 疑似含手机号`)
    assert.ok(!/\b(sessionid|sid_guard|uid_tt|passport_csrf_token)\b/i.test(html), `${f} 疑似含 Cookie/token`)
    assert.ok(!/wxid_[A-Za-z0-9]+/.test(html), `${f} 疑似含微信号`)
  }
})