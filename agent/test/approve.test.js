'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const batches = require('../src/store/batches');
const reviewBatch = require('../src/tools/review_batch');
const approveBatch = require('../src/tools/approve_batch');
const helpers = require('./helpers');

// 评审项：发送是 probe 早就实现并真机验证过的能力；agent 层现在把它接出来了，
// 但接出来的是【审批】，不是"直接发"：
//   · 投诉由代码预筛，不进候选；
//   · 每一条都要单独向服务端申请授权，服务端不给就不发；
//   · 文案只能来自冻结计划，调用方不许自带。

const SCOPE = 'testscope000000000000000000000000';
const TENANT = 'tenant-a';
const TOKEN = 'token-a';
const SEC_UID = 'MS4wLjABAAAAgy1IqwTz0xU2zIAYK9Xu58PXZPpYdQg_IkUoA8EeDxvGjtah-w_foWR4Jj6MPC0S';

function ctx(cfg) {
  return { config: cfg, agentStateDir: cfg.agentStateDir, accountScope: null };
}

async function startAuthority(handler) {
  const server = http.createServer(handler);
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  return { base: 'http://127.0.0.1:' + server.address().port,
           close: function () { return new Promise(function (r) { server.close(r); }); } };
}

// 授权服务：策略永远可用；逐条授权按 granted 集合决定。
function authorityHandler(grantedSendIds) {
  return function (request, response) {
    let raw = '';
    request.on('data', function (c) { raw += c; });
    request.on('end', function () {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET') {
        response.writeHead(200);
        response.end(JSON.stringify({ ok: true, source: 'server_settings',
          policyRef: { policyId: 'send-policy:' + TENANT, policyVersion: 1 },
          limits: { perUser: 1, hourly: 20, daily: 50 }, observation: { active: false } }));
        return;
      }
      const body = JSON.parse(raw || '{}');
      const allow = !grantedSendIds || grantedSendIds.indexOf(body.sendId) !== -1;
      response.writeHead(allow ? 200 : 409);
      response.end(allow
        ? JSON.stringify({ ok: true, status: 'granted', authorizationId: 'auth-' + body.sendId, expiresAtMs: Date.now() + 60000 })
        : JSON.stringify({ ok: false, status: 'denied', reason: 'quota_daily', detail: { limit: 0 } }));
    });
  };
}

const agentSendId = 'agent:b-1:e1';

function seedBatch(cfg, targets) {
  return batches.write(cfg.agentStateDir, SCOPE, {
    batchId: 'b-1', accountScope: SCOPE, sourceType: 'comment', frozenAtMs: Date.now(),
    policyRef: { policyId: 'send-policy:' + TENANT, policyVersion: 1 },
    policySource: 'server_settings', replyMode: 'composer', replyVia: null, blocked: null,
    targets: targets
  });
}

test('get_batch_report：probe 的 privateCandidates 是【条数】，不能被吞成空数组', async function () {
  // 真机踩过：probe 返回 privateCandidates: 1（len(allowed)），
  // 我按列表去 mask -> Array.isArray(1) 为 false -> [] ——
  // "两阶段已放行 1 条"被误报成"一条都没有"。
  const getBatchReport = require('../src/tools/get_batch_report');
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), {
    accountScope: SCOPE,
    methods: { comment_result: {
      status: 'frozen',
      counts: { planned: 1, sent_confirmed: 1 },
      privateCandidates: 1,
      privateRejected: [{ eventId: 'e2', reason: 'public_planned' }],
      privateCounts: {}
    } }
  });
  const out = await getBatchReport.run({ config: cfg, agentStateDir: cfg.agentStateDir, accountScope: null },
    { batchId: 'b-1' });
  assert.strictEqual(out.ok, true, out.reason || out.message);
  assert.strictEqual(out.result.batchStatus, 'frozen');
  assert.strictEqual(out.result.privateCandidateCount, 1, '条数必须原样报出来');
  assert.strictEqual(out.result.privatePhaseUnlocked, true);
  assert.strictEqual(out.result.privateRejected.length, 1);
  assert.strictEqual(out.result.privateRejected[0].reason, 'public_planned');
});

test('review_batch：投诉与无关由【代码】预筛，不进候选', async function () {
  const fake = await startAuthority(authorityHandler(null));
  try {
    const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
    cfg.authorityUrl = fake.base;
    cfg.authorityToken = TOKEN;
    const salt = require('../src/store/leads').ensureSalt(cfg.agentStateDir, SCOPE);
    const hash = function (raw) { return require('../src/store/leads').hashSubject(salt, raw); };
    helpers.writeLeads(cfg, SCOPE, [
      { leadId: hash('author-ok'), intent: 'price_inquiry' },
      { leadId: hash('author-complaint'), intent: 'complaint' },
      { leadId: hash('author-noise'), intent: 'irrelevant' }
    ]);
    seedBatch(cfg, [
      { eventId: 'e1', authorHash: hash('author-ok'), text: '多少钱', publicText: 'p1', privateText: 'v1' },
      { eventId: 'e2', authorHash: hash('author-complaint'), text: '骗子', publicText: 'p2', privateText: 'v2' },
      { eventId: 'e3', authorHash: hash('author-noise'), text: '哈哈', publicText: 'p3', privateText: 'v3' }
    ]);

    const out = await reviewBatch.run(ctx(cfg), { batchId: 'b-1' });
    assert.strictEqual(out.ok, true, out.reason);
    assert.deepStrictEqual(out.result.items.map(function (i) { return i.eventId; }), ['e1']);
    assert.strictEqual(out.result.items[0].intent, 'price_inquiry');
    assert.strictEqual(out.result.items[0].sendId, batches.sendIdFor('b-1', 'e1'), 'sendId 必须确定性');
    // 投诉被挡下，并说明必须转人工
    const excluded = out.result.excludedByCode;
    assert.strictEqual(excluded.length, 2);
    assert.strictEqual(excluded.find(function (e) { return e.eventId === 'e2'; }).reason, 'complaint_requires_human');
    // 私信话术与 publicSendId 在公屏确认之前不得出现在候选里
    assert.strictEqual(out.result.items[0].publicSendId, null);
    assert.strictEqual(out.result.items[0].privateText, undefined);
  } finally {
    await fake.close();
  }
});

test('review_batch：拿不到服务端策略就不给候选（fail-closed）', async function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  cfg.authorityUrl = 'http://127.0.0.1:1';
  seedBatch(cfg, [{ eventId: 'e1', authorHash: 'h1' }]);
  const out = await reviewBatch.run(ctx(cfg), { batchId: 'b-1' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'blocked/authorization_unavailable');
});

test('approve_batch：只发被服务端授权的那几条，未授权的一条也不发', async function () {
  const fake = await startAuthority(authorityHandler(['agent:b-1:e1']));
  const recorded = path.join(os.tmpdir(), 'approve-' + Date.now() + '.jsonl');
  try {
    const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), {
      accountScope: SCOPE, recordParamsTo: recorded,
      methods: { comment_reply: { status: 'ok', results: [{ eventId: 'e1', status: 'sent_confirmed' }], checkpoint: { v: 1 } } }
    });
    cfg.authorityUrl = fake.base;
    cfg.authorityToken = TOKEN;

    const out = await approveBatch.run(ctx(cfg), {
      batchId: 'b-1',
      decisions: [
        { eventId: 'e1', sendId: 'agent:b-1:e1', action: 'approve' },
        { eventId: 'e2', sendId: 'agent:b-1:e2', action: 'approve' },
        { eventId: 'e3', sendId: 'agent:b-1:e3', action: 'reject' }
      ]
    });
    assert.strictEqual(out.ok, true, out.reason);
    assert.strictEqual(out.result.approved, 1, '只有一条拿到授权');
    assert.strictEqual(out.result.blocked.length, 1);
    assert.strictEqual(out.result.blocked[0].code, 'blocked/quota_daily');
    assert.deepStrictEqual(out.result.queuedSendIds, ['agent:b-1:e1']);

    // 交给 probe 的只有被授权的那一条
    const lines = fs.readFileSync(recorded, 'utf8').trim().split(/\r?\n/).map(function (l) { return JSON.parse(l); });
    const call = lines.find(function (l) { return l.method === 'comment_reply'; });
    assert.ok(call, '应当调用过 comment_reply');
    assert.deepStrictEqual(call.params.items.map(function (i) { return i.sendId; }), ['agent:b-1:e1']);
    // 两阶段：公屏阶段的 items 不带 publicSendId
    assert.strictEqual(call.params.items[0].publicSendId, null);
  } finally {
    await fake.close();
  }
});

test('approve_batch：执行完把【台账原始状态】commit 回服务端（私信的前提）', async function () {
  // 真机发现的漏洞：执行完从不 commit。后果是服务端配额不释放，
  // 而且服务端从没见过"公屏已确认"，私信授权永远拿不到。
  // 上报必须用台账原始状态：probe 对外 status 会把 sent_confirmed 投影成 unknown。
  const commits = [];
  const fake = await startAuthority(function (request, response) {
    let raw = '';
    request.on('data', function (c) { raw += c; });
    request.on('end', function () {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET') {
        response.writeHead(200);
        response.end(JSON.stringify({ ok: true, source: 'server_settings',
          policyRef: { policyId: 'send-policy:' + TENANT, policyVersion: 1 },
          limits: { perUser: 1, hourly: 20, daily: 50 }, observation: { active: false } }));
        return;
      }
      if (request.url.indexOf('/commit') !== -1) {
        commits.push({ url: request.url, body: JSON.parse(raw || '{}') });
        response.writeHead(200);
        response.end(JSON.stringify({ ok: true, state: JSON.parse(raw || '{}').state }));
        return;
      }
      const body = JSON.parse(raw || '{}');
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true, status: 'granted', authorizationId: 'auth-' + body.sendId, expiresAtMs: Date.now() + 60000 }));
    });
  });
  try {
    const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), {
      accountScope: SCOPE,
      methods: { comment_reply: { status: 'ok', results: [{ eventId: 'e1', status: 'unknown' }] } }
    });
    cfg.authorityUrl = fake.base;
    cfg.authorityToken = TOKEN;
    helpers.seedSends(cfg, [
      { accountScope: SCOPE, sendId: agentSendId, targetKey: 't1', kind: 'comment', status: 'sent_confirmed', createdAtMs: Date.now() - 1000 }
    ]);
    const out = await approveBatch.run(ctx(cfg), {
      batchId: 'b-1', decisions: [{ eventId: 'e1', sendId: agentSendId, action: 'approve' }]
    });
    assert.strictEqual(out.ok, true, out.reason || out.message);
    assert.strictEqual(out.result.authorityCommitFailed, 0);
    assert.strictEqual(out.result.authorityCommits[0].ledgerState, 'sent_confirmed');
    assert.strictEqual(out.result.authorityCommits[0].committedState, 'sent_confirmed',
      '必须上报台账里的真实状态，而不是 probe 对外投影的 unknown');
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(commits[0].body.state, 'sent_confirmed');
  } finally {
    await fake.close();
  }
});

test('approve_batch：台账说 unknown 就上报 unknown，绝不冒充成功', async function () {
  const commits = [];
  const fake = await startAuthority(function (request, response) {
    let raw = '';
    request.on('data', function (c) { raw += c; });
    request.on('end', function () {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET') {
        response.writeHead(200);
        response.end(JSON.stringify({ ok: true, source: 'server_settings',
          policyRef: { policyId: 'send-policy:' + TENANT, policyVersion: 1 },
          limits: { perUser: 1, hourly: 20, daily: 50 }, observation: { active: false } }));
        return;
      }
      if (request.url.indexOf('/commit') !== -1) {
        commits.push(JSON.parse(raw || '{}'));
        response.writeHead(200); response.end(JSON.stringify({ ok: true }));
        return;
      }
      const body = JSON.parse(raw || '{}');
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true, status: 'granted', authorizationId: 'auth-' + body.sendId }));
    });
  });
  try {
    const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), {
      accountScope: SCOPE, methods: { comment_reply: { status: 'ok' } }
    });
    cfg.authorityUrl = fake.base;
    cfg.authorityToken = TOKEN;
    helpers.seedSends(cfg, [
      { accountScope: SCOPE, sendId: 'raw-unknown', targetKey: 't1', kind: 'comment', status: 'unknown', createdAtMs: Date.now() - 1000 },
      { accountScope: SCOPE, sendId: 'raw-reserved', targetKey: 't2', kind: 'comment', status: 'reserved', createdAtMs: Date.now() - 1000 }
    ]);
    // 台账里是 unknown / reserved -> 都必须上报 unknown
    for (const sendId of ['raw-unknown', 'raw-reserved']) {
      const out = await approveBatch.run(ctx(cfg), {
        batchId: 'b-1', decisions: [{ eventId: 'e1', sendId: sendId, action: 'approve' }]
      });
      assert.strictEqual(out.result.authorityCommits[0].committedState, 'unknown', sendId);
    }
    assert.deepStrictEqual(commits.map(function (c) { return c.state; }), ['unknown', 'unknown']);
  } finally {
    await fake.close();
  }
});

test('approve_batch：一条都没授权时，连 probe 都不碰', async function () {
  const fake = await startAuthority(authorityHandler([]));
  const recorded = path.join(os.tmpdir(), 'approve-none-' + Date.now() + '.jsonl');
  try {
    const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), {
      accountScope: SCOPE, recordParamsTo: recorded,
      methods: { comment_reply: { status: 'ok' } }
    });
    cfg.authorityUrl = fake.base;
    const out = await approveBatch.run(ctx(cfg), {
      batchId: 'b-1', decisions: [{ eventId: 'e1', sendId: 'agent:b-1:e1', action: 'approve' }]
    });
    assert.strictEqual(out.ok, true, out.reason);
    assert.strictEqual(out.result.approved, 0);
    assert.strictEqual(out.result.results, null);
    assert.ok(!fs.existsSync(recorded), '没有任何授权时不该调用执行器');
  } finally {
    await fake.close();
  }
});

test('approve_batch：文案只能来自冻结计划，调用方自带即拒', async function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const out = await approveBatch.run(ctx(cfg), {
    batchId: 'b-1',
    decisions: [{ eventId: 'e1', sendId: 's1', action: 'approve', text: '我自己编的话术' }]
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'blocked/invalid_input');
});

test('approve_batch：action 只允许 approve/reject/skip', async function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  for (const action of ['send', 'approve_all', 'force', '']) {
    const out = await approveBatch.run(ctx(cfg), {
      batchId: 'b-1', decisions: [{ eventId: 'e1', sendId: 's1', action: action }]
    });
    assert.strictEqual(out.ok, false, action);
    assert.strictEqual(out.code, 'blocked/invalid_input');
  }
});
