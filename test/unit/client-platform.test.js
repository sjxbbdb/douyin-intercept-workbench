'use strict'

// test/unit/client-platform.test.js
// 平台层测试（**离线**）—— 判据正确性 + 成功/失败口径。
//
// ⚠️ 本文件验证的核心命题是**口径**，不是"页面能不能操作"：
//    · 空响应必须是风控拒绝，不是成功（红线 2）
//    · DOM 判据只能出 `sent_confirmed_dom`，且它默认不计费
//    · 抓不到响应只能出 `sent_suspected`，**绝不能**出 `sent_confirmed`
//    · 未超容差 ≠ 成功：`status_code` 缺省时不得默认成 0
//
// ⚠️ 页面操作本身（点击、输入、滚动）**无法离线验证**，必须有真机。
//    所以这里对页面模型只验证"表达式生成与错误归因"，
//    凡是"页面会不会真的这样表现"的结论一律不下——
//    `AGENTS.md` §6 明确禁止把未真机验证的页面功能声明为完成。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const PV = require('../../client/platform/publish-verifier')
const { CommentPage } = require('../../client/platform/page-comment')
const { LivePage, isSystemMessage, SYSTEM_MESSAGE_PREFIXES } = require('../../client/platform/page-live')
const { ProfilePage, extractSecUidFromPath, normalizeText } = require('../../client/platform/page-profile')
const W = require('../../client/core/workbench-error')

// ══════════════════════════════════════════════════════════
// 假 BrowserHost：只记录调用，不真的碰浏览器
// ══════════════════════════════════════════════════════════

function fakeHost(opts = {}) {
  return {
    calls: [],
    captured: opts.captured || [],
    cursor: 0,
    async ensureTab(role, url, o) { this.calls.push({ op: 'ensureTab', role, url, o }) },
    async evaluate(role, expr, o) {
      this.calls.push({ op: 'evaluate', role, expr, o })
      const handler = opts.evaluate
      if (typeof handler === 'function') return handler(expr, this.calls.length)
      return opts.evaluateResult
    },
    async click(role, arg) { this.calls.push({ op: 'click', role, arg }) },
    // ⚠️ 平台层用的是坐标原语 `clickAt`（因为定位判据只能在页面里算，
    //    算出来的是 rect 而不是选择器）。替身必须提供它，否则平台层
    //    走到点击那一步会 TypeError —— 而那种失败会伪装成"选择器问题"。
    async clickAt(role, at, o) { this.calls.push({ op: 'clickAt', role, at, o }) },
    async typeText(role, text, o) { this.calls.push({ op: 'typeText', role, text, o }) },
    async pressEnter(role) { this.calls.push({ op: 'pressEnter', role }) },
    async startResponseCapture(role, o) { this.calls.push({ op: 'startResponseCapture', role, o }) },
    async stopResponseCapture() { this.calls.push({ op: 'stopResponseCapture' }); return { ok: true } },
    async waitForResponse(o) {
      this.calls.push({ op: 'waitForResponse', o })
      if (opts.waitForResponseThrows) throw new Error(opts.waitForResponseThrows)
      return opts.response || null
    },
    responseCursor() { return this.cursor },
  }
}

// ══════════════════════════════════════════════════════════
// 本地归因码
// ══════════════════════════════════════════════════════════

test('归因码：未知码必须抛错，不给默认值（否则笔误静默变 INTERNAL）', () => {
  assert.throws(() => new W.WorkbenchError('NOT_A_REAL_CODE', 'x'), /未知的本地归因码/)
  assert.doesNotThrow(() => new W.WorkbenchError('ELEMENT_TIMEOUT', 'x'))
})

test('归因码：可重试性内建在码表里（调度器不维护平行名单）', () => {
  // 页面/连接类 → 可重试（自愈率靠它们）
  for (const c of ['ELEMENT_TIMEOUT', 'TAB_LOST', 'CDP_DISCONNECTED', 'SELECTOR_MISS']) {
    assert.strictEqual(W.isRetryable(c), true, `${c} 应可重试`)
  }
  // 平台语义类 → 不可重试（重试只是再撞一次墙）
  for (const c of ['NOTE_POST_UNSUPPORTED', 'RISK_CONTROL_REJECTED', 'LOGIN_EXPIRED', 'NOT_LOCATABLE']) {
    assert.strictEqual(W.isRetryable(c), false, `${c} 不应重试`)
  }
  // ⚠️ 未知码一律不可重试：宁可停下让人看，也不要无限循环。
  assert.strictEqual(W.isRetryable('WHATEVER'), false)
})

test('归因码：未知异常归一成 INTERNAL 且保留原始码供排障', () => {
  const e = new Error('boom')
  e.code = 'SOMETHING_WEIRD'
  const w = W.toWorkbenchError(e)
  assert.strictEqual(w.code, 'INTERNAL')
  assert.strictEqual(w.detail.cause_code, 'SOMETHING_WEIRD')
  assert.strictEqual(w.detail.cause, 'boom')
})

// ══════════════════════════════════════════════════════════
// 响应翻译（红线 2）
// ══════════════════════════════════════════════════════════

test('状态码提取：顶层/嵌套/驼峰都认；缺失必须是 null 而不是 0', () => {
  assert.strictEqual(PV.extractStatusCode({ status_code: 0 }), 0)
  assert.strictEqual(PV.extractStatusCode({ statusCode: 4 }), 4)
  assert.strictEqual(PV.extractStatusCode({ data: { status_code: 8 } }), 8)
  assert.strictEqual(PV.extractStatusCode({ data: { statusCode: 2 } }), 2)
  // ⚠️ 最关键的一条：缺省**不能**默认成 0。
  //    默认成 0 等于把所有异常响应判成成功，正是旧代码的口径缺陷。
  assert.strictEqual(PV.extractStatusCode({ ok: true }), null)
  assert.strictEqual(PV.extractStatusCode(null), null)
  assert.strictEqual(PV.extractStatusCode('nope'), null)
})

test('响应翻译：status_code=0 → sent_confirmed + platform_response（唯一可计费形态）', async () => {
  const host = fakeHost({ response: { status: 200, rawBody: '{"status_code":0,"data":{"cid":"1"}}' } })
  const v = new PV.PublishVerifier({ browserHost: host })
  await v.beginCapture('comment', 'comment/publish')
  const r = await v.verify({ sentAtMs: Date.now() - 100 })

  assert.strictEqual(r.verdict, 'sent_confirmed')
  assert.strictEqual(r.evidence.confirm_signal, 'platform_response')
  assert.strictEqual(r.evidence.platform_status_code, 0)
  assert.strictEqual(r.evidence.platform_endpoint, 'comment/publish')
  assert.strictEqual(r.failure_reason, null)
  assert.strictEqual(r.is_final, true)
  // ⚠️ 响应体本身**不入库**（里面有评论 ID 与用户标识）
  assert.ok(!('body' in r.evidence))
  assert.strictEqual(typeof r.evidence.response_bytes, 'number')
})

test('响应翻译：空响应 = 风控拒绝，绝不判成功（契约 §4.8）', async () => {
  const host = fakeHost({ response: { status: 200, rawBody: '' } })
  const v = new PV.PublishVerifier({ browserHost: host })
  await v.beginCapture('comment', 'comment/publish')
  const r = await v.verify()

  assert.strictEqual(r.verdict, 'failed', '空响应绝不能是成功')
  assert.strictEqual(r.evidence.risk_control_signal, 'empty_response')
  assert.strictEqual(r.failure_reason, 'risk_control_rejected')
  assert.strictEqual(r.evidence.confirm_signal, 'none')
})

test('响应翻译：HTTP 200 但业务码非 0 → failed，并按码映射归因', async () => {
  const cases = [
    [4, 'rate_limited'],
    [8, 'risk_control_rejected'],
    [2, 'content_rejected'],
    [9, 'blocked_by_target'],
    [1, 'unknown'],
  ]
  for (const [code, reason] of cases) {
    const host = fakeHost({ response: { status: 200, rawBody: JSON.stringify({ status_code: code }) } })
    const v = new PV.PublishVerifier({ browserHost: host })
    await v.beginCapture('comment', 'comment/publish')
    const r = await v.verify()
    assert.strictEqual(r.verdict, 'failed', `码 ${code} 应判 failed`)
    assert.strictEqual(r.failure_reason, reason, `码 ${code} 应映射成 ${reason}`)
    assert.strictEqual(r.evidence.platform_status_code, code)
  }
})

test('响应翻译：有 JSON 但没有 status_code → 保守判 failed（不得当成功）', async () => {
  const host = fakeHost({ response: { status: 200, rawBody: '{"ok":true,"msg":"done"}' } })
  const v = new PV.PublishVerifier({ browserHost: host })
  await v.beginCapture('comment', 'comment/publish')
  const r = await v.verify()
  assert.strictEqual(r.verdict, 'failed')
  assert.strictEqual(r.evidence.note, 'status_code_absent')
})

test('响应翻译：返回 HTML 拦截页（含风控词）→ 判风控拒绝', async () => {
  const host = fakeHost({
    response: { status: 200, rawBody: '<html><body>请完成验证后继续</body></html>' },
  })
  const v = new PV.PublishVerifier({ browserHost: host })
  await v.beginCapture('comment', 'comment/publish')
  const r = await v.verify()
  assert.strictEqual(r.verdict, 'failed')
  assert.strictEqual(r.failure_reason, 'risk_control_rejected')
  assert.strictEqual(r.evidence.risk_control_signal, 'interstitial_page')
})

test('响应翻译：HTTP 429 → rate_limited', async () => {
  const host = fakeHost({ response: { status: 429, rawBody: '{"msg":"too many"}' } })
  const v = new PV.PublishVerifier({ browserHost: host })
  await v.beginCapture('comment', 'comment/publish')
  const r = await v.verify()
  assert.strictEqual(r.verdict, 'failed')
  assert.strictEqual(r.failure_reason, 'rate_limited')
})

test('响应翻译：完全没抓到响应 → sent_suspected（不是 failed，也不是 confirmed）', async () => {
  const host = fakeHost({ waitForResponseThrows: 'timeout' })
  const v = new PV.PublishVerifier({ browserHost: host })
  await v.beginCapture('comment', 'comment/publish')
  const r = await v.verify({ timeoutMs: 50 })

  assert.strictEqual(r.verdict, 'sent_suspected',
    '抓不到响应只能"疑似"——判 confirmed 就是旧代码那个致命缺陷')
  assert.strictEqual(r.evidence.confirm_signal, 'none')
  assert.strictEqual(r.is_final, false, '未终局，允许后续升级为 sent_confirmed')
  assert.strictEqual(r.failure_reason, null)
  assert.strictEqual(r.evidence.note, 'no_response_captured')
})

test('响应翻译：抓不到响应不是异常路径 —— 不得上抛（上抛会导致重发）', async () => {
  const host = fakeHost({ waitForResponseThrows: 'Network.getResponseBody failed' })
  const v = new PV.PublishVerifier({ browserHost: host })
  await v.beginCapture('comment', 'comment/publish')
  await assert.doesNotReject(() => v.verify({ timeoutMs: 50 }))
})

test('endpoint 闭集白名单：完整 URL / 域名一律拒绝', async () => {
  const host = fakeHost({})
  const v = new PV.PublishVerifier({ browserHost: host })
  for (const bad of ['https://www.douyin.com/aweme/v1/comment/publish', 'douyin.com', 'whatever']) {
    await assert.rejects(() => v.beginCapture('comment', bad), /闭集白名单/,
      `${bad} 应被拒绝（契约 §4.8 禁止完整 URL 与域名）`)
  }
  // 四个合法值都应通过
  for (const ok of ['comment/publish', 'comment/reply', 'im/send', 'live/comment/send']) {
    const h2 = fakeHost({})
    const v2 = new PV.PublishVerifier({ browserHost: h2 })
    await assert.doesNotReject(() => v2.beginCapture('t', ok))
  }
})

test('DOM 判据：独立入口且产出 sent_confirmed_dom（不得混成 confirmed）', () => {
  const r = PV.PublishVerifier.domConfirmed({ stableMs: 3200, sentAtMs: Date.now() - 5000 })
  assert.strictEqual(r.verdict, 'sent_confirmed_dom',
    'DOM 判据只能是 dom 版 —— 它默认不计费（契约 §6.1）')
  assert.strictEqual(r.evidence.confirm_signal, 'dom_stable')
  assert.strictEqual(r.evidence.dom_stable_ms, 3200)
  assert.strictEqual(r.evidence.note, 'dom_only_not_billable')
})

test('闭集自检工具：failure_reason 与 confirm_signal 越界可被发现', () => {
  assert.strictEqual(PV.isKnownFailureReason('risk_control_rejected'), true)
  assert.strictEqual(PV.isKnownFailureReason(null), true)
  assert.strictEqual(PV.isKnownFailureReason('made_up_reason'), false)
  assert.strictEqual(PV.isKnownConfirmSignal('platform_response'), true)
  assert.strictEqual(PV.isKnownConfirmSignal('editor_disappeared'), false,
    '旧代码的判据名不在闭集里 —— 它本来就不该作为确认信号')
})

test('抓取必须在发送之前开始（否则响应可能已经过去了）', async () => {
  const host = fakeHost({ response: { status: 200, rawBody: '{"status_code":0}' } })
  const v = new PV.PublishVerifier({ browserHost: host })
  await v.beginCapture('comment', 'comment/publish')
  const ops = host.calls.map((c) => c.op)
  assert.strictEqual(ops[0], 'startResponseCapture',
    'beginCapture 的第一步就必须打开捕获')
})

test('抓完之后必须关掉捕获（否则监听器泄漏，越跑越慢）', async () => {
  const host = fakeHost({ response: { status: 200, rawBody: '{"status_code":0}' } })
  const v = new PV.PublishVerifier({ browserHost: host })
  await v.beginCapture('comment', 'comment/publish')
  await v.verify()
  assert.ok(host.calls.some((c) => c.op === 'stopResponseCapture'), '必须关掉捕获')

  // 抓不到响应的分支同样要关
  const h2 = fakeHost({ waitForResponseThrows: 'timeout' })
  const v2 = new PV.PublishVerifier({ browserHost: h2 })
  await v2.beginCapture('comment', 'comment/publish')
  await v2.verify({ timeoutMs: 20 })
  assert.ok(h2.calls.some((c) => c.op === 'stopResponseCapture'),
    '异常分支也必须关掉捕获')
})

// ══════════════════════════════════════════════════════════
// 评论区页面模型（离线：只验判据与归因）
// ══════════════════════════════════════════════════════════

test('评论区：图文帖判 NOTE_POST_UNSUPPORTED（不可重试，不进重试循环）', async () => {
  const host = fakeHost({
    evaluate: (expr) => {
      if (expr.includes('note-detail-container')) return true
      return { ok: true, items: [] }
    },
  })
  const page = new CommentPage({ host })
  await assert.rejects(
    () => page.open('https://www.douyin.com/note/123'),
    (e) => {
      assert.ok(e instanceof W.WorkbenchError)
      assert.strictEqual(e.code, 'NOTE_POST_UNSUPPORTED')
      assert.strictEqual(e.retryable, false, '图文帖是语义性不支持，重试毫无意义')
      return true
    }
  )
})

test('评论区：找不到可见容器 → SELECTOR_MISS 且带上选择器 key（改版定位线索）', async () => {
  const host = fakeHost({ evaluate: () => ({ ok: false, reason: 'no_visible_root' }) })
  const page = new CommentPage({ host })
  await assert.rejects(
    () => page.scan(),
    (e) => {
      assert.strictEqual(e.code, 'SELECTOR_MISS')
      assert.strictEqual(e.detail.selector, 'commentList',
        '必须带 key —— 改版时这是唯一有用的线索')
      return true
    }
  )
})

test('评论区：scan 生成的表达式必须筛选可见容器并与 legacy 归一化一致', async () => {
  let seen = null
  const host = fakeHost({ evaluate: (expr) => { seen = expr; return { ok: true, items: [], total: 0 } } })
  const page = new CommentPage({ host })
  await page.scan()

  assert.ok(seen.includes('__visible'), '必须检查可见性（隐藏副本的按钮尺寸为 0）')
  assert.ok(seen.includes('__root'), '必须先挑出可见的评论列表根')
  assert.ok(seen.includes('scrollTop') === false, 'scan 不应滚动')
  // 归一化必须剔除零宽字符 —— 平台会在评论文本里插它们
  assert.ok(seen.includes('\\u200b') || seen.includes('\u200b'), '归一化必须处理零宽字符')
})

test('评论区：激活编辑器失败时必须明确"为避免发成顶级评论而放弃"', async () => {
  const host = fakeHost({
    evaluate: (expr) => {
      if (expr.includes('note-detail-container')) return false
      // 一直返回"不在回复态"
      if (expr.includes('__visible')) return true // waitForVisible
      return { ok: false, reason: 'not_in_reply_mode' }
    },
  })
  const page = new CommentPage({ host })
  await assert.rejects(
    () => page.activateInlineEditor({ bodyKey: 'k', userKey: 'u', attempts: 1 }),
    (e) => {
      assert.strictEqual(e.code, 'ELEMENT_TIMEOUT')
      assert.match(e.message, /顶级评论/, '必须说明失败是为了避免发错地方')
      assert.strictEqual(e.retryable, true, '页面问题可重试')
      return true
    }
  )
})

test('评论区：目标评论不在页面上 → NOT_LOCATABLE 且不可重试', async () => {
  const host = fakeHost({
    evaluate: (expr) => {
      if (expr.includes('note-detail-container')) return false
      return { ok: false, reason: 'target_item_not_found' }
    },
  })
  const page = new CommentPage({ host })
  await assert.rejects(
    () => page.activateInlineEditor({ bodyKey: 'k', userKey: 'u', attempts: 1 }),
    (e) => {
      assert.strictEqual(e.code, 'NOT_LOCATABLE')
      assert.strictEqual(e.retryable, false, '评论被删除，重试没有意义')
      return true
    }
  )
})

test('评论区：激活表达式必须显式排除主评论输入框（否则会发成顶级评论）', async () => {
  let editorExpr = null
  const host = fakeHost({
    evaluate: (expr) => {
      if (expr.includes('note-detail-container')) return false
      if (expr.includes('contenteditable')) editorExpr = expr
      return { ok: false, reason: 'not_in_reply_mode' }
    },
  })
  const page = new CommentPage({ host })
  await page.activateInlineEditor({ bodyKey: 'k', userKey: 'u', attempts: 1 }).catch((e) => {
    assert.ok(e instanceof W.WorkbenchError)
  })

  assert.ok(editorExpr, '应当生成了编辑器探测表达式')
  assert.ok(editorExpr.includes('comment-input-container'),
    '⚠️ 必须显式排除主评论输入框 —— 往那里输入会发出一条顶级评论，' +
    '而平台照样返回 status_code:0，属于"看起来成功"的静默错误')
  assert.ok(editorExpr.includes('\\u56de\\u590d\\u4e2d') || editorExpr.includes('回复中'),
    '必须要求所在评论项处于「回复中」状态')
})

test('评论区：找「回复」按钮的判据是文本严格等于「回复」并排除弹幕', async () => {
  let btnExpr = null
  const host = fakeHost({
    evaluate: (expr) => {
      if (expr.includes('note-detail-container')) return false
      if (expr.includes('danmaku')) btnExpr = expr
      return { ok: false, reason: 'not_in_reply_mode' }
    },
  })
  const page = new CommentPage({ host })
  await page.activateInlineEditor({ bodyKey: 'k', userKey: 'u', attempts: 1 }).catch((e) => {
    assert.ok(e instanceof W.WorkbenchError)
  })
  assert.ok(btnExpr, '应生成按钮查找表达式')
  // 严格相等：不能是 indexOf('回复') —— 那会命中「回复中」「回复了」
  assert.ok(btnExpr.includes("t!=='\\u56de\\u590d'") || btnExpr.includes("!=='回复'"),
    '必须是严格相等，否则会命中「回复中」这类元素')
  assert.ok(btnExpr.includes('danmaku'), '必须排除弹幕容器里的同名元素')
})

// ══════════════════════════════════════════════════════════
// 直播间页面模型
// ══════════════════════════════════════════════════════════

test('直播间：系统消息必须被识别并排除（回复它们等于对空气说话）', () => {
  for (const t of ['进入直播间', '点赞了主播', '关注了主播', '送出了小心心', '拍了拍主播']) {
    assert.strictEqual(isSystemMessage(t), true, `${t} 应判为系统消息`)
  }
  assert.strictEqual(isSystemMessage('这个商品多少钱'), false)
  assert.strictEqual(isSystemMessage(''), true)
  assert.ok(SYSTEM_MESSAGE_PREFIXES.length >= 8, '系统消息前缀表不能太少，否则会把系统消息当用户发言')
})

test('直播间：直播已结束 → NOT_LOCATABLE（不该干等到超时）', async () => {
  let n = 0
  const host = fakeHost({
    evaluate: (expr) => {
      n++
      if (expr.includes('直播已结束') || expr.includes('\\u76f4\\u64ad\\u5df2\\u7ed3\\u675f')) return true
      return 0 // 弹幕数量为 0
    },
  })
  const page = new LivePage({ host })
  await assert.rejects(
    () => page.open('https://live.douyin.com/123', { timeoutMs: 3000 }),
    (e) => {
      assert.strictEqual(e.code, 'NOT_LOCATABLE')
      assert.match(e.message, /已结束|回放/)
      return true
    }
  )
  assert.ok(n > 0)
})

test('直播间：采集表达式必须做长度约束与去重（宁缺勿错）', async () => {
  let seen = null
  const host = fakeHost({ evaluate: (expr) => { seen = expr; return { ok: true, rows: [], matched_nodes: 0 } } })
  const page = new LivePage({ host })
  const rows = await page.collect()
  assert.ok(Array.isArray(rows))
  assert.ok(seen.includes('user.length>48'), '昵称过长直接丢弃，不做猜测')
  assert.ok(seen.includes('text.length>260'), '正文过长直接丢弃')
  assert.ok(seen.includes('if(ls.length<2) continue'), '解析不出一行以上的直接丢（宁缺勿错）')
  assert.ok(seen.includes('seen[key]'), '同一行内必须去重')
  // 诊断信息必须带回来 —— 弹幕选择器是 low confidence，改版只能靠它定位
  assert.ok(rows.diagnostics, '必须返回诊断信息')
  assert.strictEqual(typeof rows.diagnostics.matched_nodes, 'number')
})

test('直播间：采集结果不得包含 secUid / 头像 / 资料页链接（红线 3）', async () => {
  const host = fakeHost({
    evaluate: () => ({
      ok: true,
      matched_nodes: 1,
      rows: [{ rowKey: 'k', user: 'u', text: 't', userId: '', rect: { x: 1, y: 2 } }],
    }),
  })
  const page = new LivePage({ host })
  const rows = await page.collect()
  const keys = Object.keys(rows[0])
  for (const forbidden of ['secUid', 'sec_uid', 'avatarUrl', 'profileUrl', 'avatar']) {
    assert.ok(!keys.includes(forbidden), `弹幕行不得带 ${forbidden}`)
  }
})

test('直播间：已见弹幕不会被重复返回，且 seen 集合有上限', () => {
  const host = fakeHost({})
  const page = new LivePage({ host })
  page.markSeen('rk-1')
  assert.strictEqual(page.seenRowKeys.has('rk-1'), true)
  // 上限保护：塞满后应收缩而不是无限增长
  page.seenLimit = 10
  for (let i = 0; i < 20; i++) page.markSeen(`rk-${i}`)
  assert.ok(page.seenRowKeys.size <= 10, `seen 集合必须收缩，实际 ${page.seenRowKeys.size}`)
})

// ══════════════════════════════════════════════════════════
// 私信页面模型
// ══════════════════════════════════════════════════════════

test('私信：取不到用户路径时必须跳过（绝不猜 —— 猜错就是给陌生人发私信）', async () => {
  const host = fakeHost({ evaluate: () => ({ found: false, reason: 'no_profile_link_near_anchor' }) })
  const page = new ProfilePage({ host })
  const r = await page.resolveUserPath({ role: 'comment', anchorText: '这个多少钱', userName: '小明' })
  assert.strictEqual(r.found, false)
  assert.strictEqual(r.reason, 'no_profile_link_near_anchor')
})

test('私信：非法用户路径直接拒绝', async () => {
  const host = fakeHost({})
  const page = new ProfilePage({ host })
  await assert.rejects(
    () => page.openConversation('/not-a-user-path'),
    (e) => e.code === 'NOT_LOCATABLE'
  )
  await assert.rejects(
    () => page.openConversation(''),
    (e) => e.code === 'NOT_LOCATABLE'
  )
})

test('私信：登录态失效 → LOGIN_EXPIRED 并明确让人去专用浏览器重新登录', async () => {
  const host = fakeHost({
    evaluate: () => ({ has_input: false, requires_login: true, is_404: false }),
  })
  const page = new ProfilePage({ host })
  await assert.rejects(
    () => page.openConversation('/user/MS4wLjABAAAA', { timeoutMs: 2000 }),
    (e) => {
      assert.strictEqual(e.code, 'LOGIN_EXPIRED')
      assert.match(e.message, /专用浏览器/, '必须告诉商家去哪里重新登录')
      return true
    }
  )
})

test('私信：用户不存在 → NOT_LOCATABLE', async () => {
  const host = fakeHost({
    evaluate: () => ({ has_input: false, requires_login: false, is_404: true }),
  })
  const page = new ProfilePage({ host })
  await assert.rejects(
    () => page.openConversation('/user/MS4wLjABAAAA', { timeoutMs: 2000 }),
    (e) => e.code === 'NOT_LOCATABLE'
  )
})

test('私信：输入框聚焦必须排除搜索框（否则文字进搜索框、Enter 会跳页）', async () => {
  let seen = null
  const host = fakeHost({ evaluate: (expr) => { seen = expr; return { ok: false, reason: 'dm_input_not_found' } } })
  const page = new ProfilePage({ host })
  await page.focusInput().catch((e) => { assert.strictEqual(e.code, 'ELEMENT_TIMEOUT') })
  assert.ok(seen.includes('search') || seen.includes('搜索'), '必须排除搜索框')
})

test('私信：sec_uid 提取只用于哈希输入，且能容忍畸形编码', () => {
  assert.strictEqual(extractSecUidFromPath('/user/MS4wLjABAAAA'), 'MS4wLjABAAAA')
  assert.strictEqual(extractSecUidFromPath('/user/a%2Fb'), 'a/b')
  // 畸形百分号编码不得抛错（它的用途只是哈希输入）
  assert.strictEqual(extractSecUidFromPath('/user/%E0%A4%A'), '%E0%A4%A')
  assert.strictEqual(extractSecUidFromPath('/video/123'), null)
  assert.strictEqual(extractSecUidFromPath(null), null)
})

test('文本归一化：三个页面模型用同一套规则（否则会出现"评论区能匹配、私信页匹配不到"）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'platform', 'page-comment.js'), 'utf8')
  const srcLive = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'platform', 'page-live.js'), 'utf8')
  const srcProfile = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'platform', 'page-profile.js'), 'utf8')
  // 三份都要剔除零宽字符与同类的标点集合
  for (const [name, s] of [['page-comment', src], ['page-live', srcLive], ['page-profile', srcProfile]]) {
    assert.ok(s.includes('\\u200b') || s.includes('\u200b'), `${name} 的归一化必须剔除零宽字符`)
  }
  // 归一化结果一致
  const a = normalizeText('  这个 商品\u200b多少钱？ ')
  assert.strictEqual(a, normalizeText('这个商品多少钱'))
})

// ══════════════════════════════════════════════════════════
// 页面模型的分层约束
// ══════════════════════════════════════════════════════════

/**
 * 剥掉注释的简化版（只为本文件的两条源码扫描服务）。
 *
 * ⚠️ 必须剥注释：这些文件的**说明性注释里**会提到"不得出现 xxx"，
 *    不剥的话那条自我约束的注释反而会被判成违规。
 *    契约测试里那份实现更完整（处理字符串与转义），这里够用即可。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

test('平台层：不得直接使用 CDP（所有动作经 browser-host）', () => {
  const dir = path.join(__dirname, '..', '..', 'client', 'platform')
  const banned = /Input\.dispatchMouseEvent|Input\.insertText|Page\.navigate|Runtime\.evaluate|Network\.getResponseBody|new WebSocket/
  const offenders = []
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const s = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'))
    if (banned.test(s)) offenders.push(f)
  }
  assert.deepStrictEqual(offenders, [],
    '平台层必须通过 browser-host 操作页面；直接调 CDP 会让"每实例一条独占 WS"的约束失效')
})

test('平台层：除 selectors.js 外不得内联选择器字符串', () => {
  const dir = path.join(__dirname, '..', '..', 'client', 'platform')
  const offenders = []
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    if (f === 'selectors.js') continue
    const s = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'))
    // ⚠️ 用 `data-e2e` 这类属性名精确匹配。故意**不**禁止
    //    `comment-input-container` 这类 class 片段：它们在 page-comment.js 里
    //    的用途是**排除**（"不得是主输入框"），是结构性事实而不是查找选择器，
    //    而且它并不住在 selectors.js 里——禁掉它反而会让那条防线没法写。
    if (/data-e2e|data-sec-uid/.test(s)) offenders.push(f)
  }
  assert.deepStrictEqual(offenders, [], '选择器字符串必须集中在 selectors.js')
})
