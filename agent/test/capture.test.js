'use strict';

const assert = require('node:assert');
const test = require('node:test');

const registry = require('../src/registry');
const helpers = require('./helpers');
const searchVideos = require('../src/tools/search_videos');
const listVideoPool = require('../src/tools/list_video_pool');
const collectComments = require('../src/tools/collect_comments');
const collectLive = require('../src/tools/collect_live');
const liveListen = require('../src/tools/live_listen');
const getBatchReport = require('../src/tools/get_batch_report');
const lifecycle = require('../src/tools/browser_lifecycle');

// 评审项：搜索/采集/直播间这些"真正干活"的功能可以给使用者用，
// 但它们【只读平台内容】—— 不许出现任何写入平台的动作，也不许出 sec_uid。

const SCOPE = 'testscope000000000000000000000000';

function ctx(cfg) {
  return { config: cfg, agentStateDir: cfg.agentStateDir, accountScope: null };
}

function capturable(plan) {
  return helpers.writeFakeSidecar(helpers.makeConfig(), Object.assign({ accountScope: SCOPE }, plan || {}));
}

const SEC_UID = 'MS4wLjABAAAAgy1IqwTz0xU2zIAYK9Xu58PXZPpYdQg_IkUoA8EeDxvGjtah-w_foWR4Jj6MPC0S';

function sampleEvent(extra) {
  return Object.assign({
    id: 'c-1', source: 'comment', roomId: 'https://www.douyin.com/video/123',
    authorId: SEC_UID, authorName: '某个观众', text: '这个怎么收费',
    observedAt: '2026-09-29T00:00:00Z', fingerprint: 'fp-1'
  }, extra || {});
}

test('三层能力各有几个工具，总数固定', function () {
  assert.strictEqual(registry.count(), 16, '工具数量变化必须同步改 docs/agent-tools.md');
  assert.deepStrictEqual(registry.countByTier(),
    { read: 5, capture: 6, plan: 2, execute: 1, lifecycle: 2 });
});

test('新增的采集/生命周期工具名都不命中执行类模式', function () {
  assert.deepStrictEqual(registry.forbiddenTools(), []);
});

test('每个工具都标了 tier 与声明字段', function () {
  registry.listTools().forEach(function (tool) {
    assert.ok(['read', 'capture', 'plan', 'execute', 'lifecycle'].indexOf(tool.declaration.tier) !== -1, tool.name);
    assert.strictEqual(typeof tool.declaration.implemented, 'boolean', tool.name);
    assert.strictEqual(typeof tool.declaration.autoEligible, 'boolean', tool.name);
    // 采集类会驱动真实浏览器，拿不到"平台送达"证据之前不许自动执行。
    if (tool.declaration.tier === 'capture' && tool.name !== 'list_video_pool' &&
        tool.name !== 'get_batch_report') {
      assert.strictEqual(tool.declaration.autoEligible, false, tool.name + ' 不该 autoEligible');
    }
    // 会写入平台内容的工具一律不许自动执行。
    if (tool.declaration.tier === 'execute') {
      assert.strictEqual(tool.declaration.autoEligible, false, tool.name + ' 是写工具，必须 autoEligible=false');
    }
  });
});

test('search_videos：关键词必填、边界校验、返回结构化候选', function () {
  const cfg = capturable({ methods: { search: {
    status: 'ok', videos: [{ aweme_id: '111', url: 'https://www.douyin.com/video/111',
      title: '怎么学习AI', author: '某作者', author_id: SEC_UID, relevance_score: 88,
      published_at: '2026-09-01' }],
    cursor: 'cur-2', hasMore: true, page: 1, poolSize: 3, skippedSeen: 0,
    filter: { minRelevance: 0 }
  } } });
  assert.strictEqual(searchVideos.run(ctx(cfg), {}).code, 'blocked/invalid_input');
  assert.strictEqual(searchVideos.run(ctx(cfg), { keyword: 'x'.repeat(121) }).code, 'blocked/invalid_input');
  assert.strictEqual(searchVideos.run(ctx(cfg), { keyword: 'a', maxVideos: 201 }).code, 'blocked/invalid_input');
  assert.strictEqual(searchVideos.run(ctx(cfg), { keyword: 'a', minRelevance: 101 }).code, 'blocked/invalid_input');

  const out = searchVideos.run(ctx(cfg), { keyword: '怎么学习AI' });
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.result.videos.length, 1);
  assert.strictEqual(out.result.videos[0].videoId, '111');
  assert.strictEqual(out.result.videos[0].relevance, 88);
  assert.strictEqual(out.result.cursor, 'cur-2');
  assert.strictEqual(out.result.hasMore, true);
  assert.ok(JSON.stringify(out).indexOf(SEC_UID) === -1, '创作者 sec_uid 泄漏了');
});

test('视频字段两面都认：search 的 id 与 search_pool 的 videoId、relevance 对象', function () {
  // 真机实测踩过：search 返回 {id, title, author, relevance:{score,reason}}，
  // search_pool 返回 {videoId, ..., relevance:{score,reason}}。
  // 只认 aweme_id、或把 relevance 当数字，结果就是 videoId 与相关度全空。
  const cfg = capturable({ methods: {
    search: { status: 'ok', videos: [{ id: '9001', url: 'u1', title: 't1', author: 'a1',
      relevance: { score: 91, reason: 'exact_phrase' }, publishedAt: '2026-09-01' }], cursor: 'c', hasMore: true },
    search_pool: { status: 'ok', videos: [{ videoId: '9002', url: 'u2', title: 't2', author: 'a2',
      keyword: 'k', relevance: { score: 77, reason: 'token_hit' } }], stats: { total: 1 } }
  } });
  const searched = searchVideos.run(ctx(cfg), { keyword: 'k' });
  assert.strictEqual(searched.result.videos[0].videoId, '9001');
  assert.strictEqual(searched.result.videos[0].relevance, 91);
  assert.strictEqual(searched.result.videos[0].relevanceReason, 'exact_phrase');

  const pooled = listVideoPool.run(ctx(cfg), {});
  assert.strictEqual(pooled.result.videos[0].videoId, '9002');
  assert.strictEqual(pooled.result.videos[0].relevance, 77);
  assert.strictEqual(pooled.result.videos[0].keyword, 'k');
});

test('search_videos：验证码是停机信号，原样抬到最外层且不重试', function () {
  const cfg = capturable({ methods: { search: { status: 'captcha', videos: [] } } });
  const out = searchVideos.run(ctx(cfg), { keyword: 'a' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'blocked/captcha_requires_manual_action');
  assert.ok(out.reason.indexOf('绝不绕过') !== -1);
});

test('非 ok 的 status 一律是阻断，绝不冒充成功（真机踩过）', function () {
  // sidecar 会用 status 表达"这次没干成"：例如 collect_comments 遇到
  // 不支持的页面类型会返回 status="unsupported" 且 events 为空。
  // 如果只看 ok 就往下走，调用方会读到"ok:true + 0 条"，
  // 误以为"抓到了但没人评论" —— 那是假的成功。
  const cfg = capturable({ methods: {
    collect_comments: { status: 'unsupported', events: [], targets: [], filter: { collected: 0 } }
  } });
  const out = collectComments.run(ctx(cfg), { url: 'https://www.douyin.com/video/1' });
  assert.strictEqual(out.ok, false, '不支持的页面类型不该报成功');
  assert.strictEqual(out.code, 'blocked/unsupported');
  assert.strictEqual(out.observedStatus, 'unsupported');
  assert.ok(out.reason.indexOf('unsupported') !== -1);
});

test('search_videos：登录失效同样是停机信号', function () {
  const cfg = capturable({ methods: { search: { status: 'login_required', videos: [] } } });
  const out = searchVideos.run(ctx(cfg), { keyword: 'a' });
  assert.strictEqual(out.code, 'blocked/not_authorized');
});

test('list_video_pool：读本地池子，给出可交给评论区的 videoId', function () {
  const cfg = capturable({ methods: { search_pool: {
    status: 'ok',
    videos: [{ aweme_id: '222', url: 'u', title: 't', author: 'a', author_id: SEC_UID,
               relevance_score: 70, keyword: '怎么学习AI', published_at: null }],
    stats: { total: 1 }
  } } });
  const out = listVideoPool.run(ctx(cfg), { limit: 10 });
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.result.videos[0].videoId, '222');
  assert.ok(JSON.stringify(out).indexOf(SEC_UID) === -1);
  assert.strictEqual(listVideoPool.run(ctx(cfg), { limit: 1001 }).code, 'blocked/invalid_input');
});

test('collect_comments：url / videoId 二选一，返回被遮蔽身份的评论', function () {
  const cfg = capturable({ methods: { collect_comments: {
    status: 'ok',
    events: [sampleEvent(), sampleEvent({ id: 'c-2', text: '666' })],
    targets: [sampleEvent()],
    filter: { visibleCount: 30, matched: 1, dedupedAuthors: 1 },
    capability: { verified: true, source: 'visible_dom' }
  } } });
  assert.strictEqual(collectComments.run(ctx(cfg), {}).code, 'blocked/invalid_input');
  assert.strictEqual(collectComments.run(ctx(cfg), { url: 'u', videoId: 'v' }).code, 'blocked/invalid_input');
  assert.strictEqual(collectComments.run(ctx(cfg), { url: 'u', matchMode: 'fuzzy' }).code, 'blocked/invalid_input');

  const out = collectComments.run(ctx(cfg), { url: 'https://www.douyin.com/video/123', commentKeywords: '111 666' });
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.result.collected, 2);
  assert.strictEqual(out.result.matched, 1);
  const serialized = JSON.stringify(out);
  assert.ok(serialized.indexOf(SEC_UID) === -1, 'sec_uid 泄漏了');
  assert.ok(serialized.indexOf('某个观众') === -1, '昵称泄漏了');
  assert.ok(serialized.indexOf('这个怎么收费') !== -1, '评论文本应当保留（否则这项功能没有意义）');
  assert.ok(out.result.events[0].authorHash, '身份必须换成加盐哈希');
  assert.strictEqual(out.result.events[0].authorHash, out.result.candidates[0].authorHash,
    '同一作者在同一账号内必须可关联');
  assert.strictEqual(out.result.candidatesAreSendable, false, 'BP0 不能声称候选可发送');
});

test('collect_live / live_listen：最大条数边界与排队信息', function () {
  const cfg = capturable({ methods: {
    collect_live: { status: 'ok', events: [sampleEvent({ source: 'live' })], capability: { verified: true } },
    live_listen: { status: 'ok', events: [sampleEvent({ source: 'live' })], queue: { total: 5 }, capability: { verified: true } }
  } });
  assert.strictEqual(collectLive.run(ctx(cfg), {}).code, 'blocked/invalid_input');
  assert.strictEqual(collectLive.run(ctx(cfg), { url: 'u', maxItems: 501 }).code, 'blocked/invalid_input');
  const live = collectLive.run(ctx(cfg), { url: 'https://live.douyin.com/1' });
  assert.strictEqual(live.ok, true, live.reason);
  assert.strictEqual(live.result.collected, 1);
  assert.ok(JSON.stringify(live).indexOf(SEC_UID) === -1);

  const listen = liveListen.run(ctx(cfg), { url: 'https://live.douyin.com/1' });
  assert.strictEqual(listen.ok, true, listen.reason);
  assert.strictEqual(listen.result.queue.total, 5);
});

test('get_batch_report：只读报告，候选清单同样只出哈希', function () {
  const cfg = capturable({ methods: { comment_result: {
    counts: { sent_confirmed: 2, unknown: 1 },
    privateCounts: { allowed: 2 },
    checkpoint: { version: 3 },
    privateCandidates: [{ eventId: 'e1', sendId: 's1', publicSendId: 'p1', authorId: SEC_UID }],
    privateRejected: [{ eventId: 'e2', reason: 'public_unknown', authorId: SEC_UID }],
    limits: { per_user: 1 }
  } } });
  assert.strictEqual(getBatchReport.run(ctx(cfg), {}).code, 'blocked/invalid_input');
  assert.strictEqual(getBatchReport.run(ctx(cfg), { batchId: 'b', sourceType: 'weibo' }).code, 'blocked/invalid_input');
  const out = getBatchReport.run(ctx(cfg), { batchId: 'b-1' });
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.result.counts.sent_confirmed, 2);
  assert.strictEqual(out.result.privateCandidates.length, 1);
  assert.ok(out.result.privateCandidates[0].authorHash);
  assert.ok(JSON.stringify(out).indexOf(SEC_UID) === -1, 'sec_uid 泄漏了');
  assert.strictEqual(out.result.candidatesAreSendable, false);
});

test('浏览器生命周期：只调 launch / close', function () {
  const cfg = capturable({ methods: { launch: { status: 'ok', port: 9222 }, close: { status: 'ok' } } });
  const started = lifecycle.startRun(ctx(cfg));
  assert.strictEqual(started.ok, true, started.reason);
  assert.ok(started.result.note.indexOf('可见') !== -1, '必须提醒窗口要保持可见');
  const closed = lifecycle.closeRun(ctx(cfg));
  assert.strictEqual(closed.ok, true, closed.reason);
});

test('采集类工具绝不出现写入平台的 sidecar 方法（静态断言）', function () {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.resolve(__dirname, '..', 'src', 'tools');
  const called = [];
  fs.readdirSync(dir).filter(function (f) { return f.endsWith('.js'); }).forEach(function (file) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8')
      .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const pattern = /(?:invoke|callOnce)\([^,)]*,?\s*'([a-z_]+)'/g;
    let match = pattern.exec(text);
    while (match) { called.push(file + ':' + match[1]); match = pattern.exec(text); }
  });
  assert.ok(called.length > 0, '没找到任何调用点，说明这条断言本身失效了');
  called.forEach(function (entry) {
    const method = entry.split(':')[1];
    assert.ok(registry.ALLOWED_SIDECAR_METHODS.indexOf(method) !== -1,
      '工具层调用了不在白名单里的方法: ' + entry);
  });
});
