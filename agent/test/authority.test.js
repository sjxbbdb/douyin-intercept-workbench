'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const authority = require('../src/authority-client');
const health = require('../src/tools/get_account_health');
const planBatch = require('../src/tools/plan_reply_batch');
const helpers = require('./helpers');

// 评审项（S3 + S4）：上限的权威在服务端，而【故障时必须 fail-closed】。
//   S3：agent 读服务端策略；拿不到就 canWork=false，绝不退回本地默认。
//   S4：冻结计划时把服务端签发的 policyRef 交给 probe（只给身份，不给内容）。

const SCOPE = 'testscope000000000000000000000000';
const TENANT = 'tenant-a';
const TOKEN = 'token-a';

function ctx(cfg) {
  return { config: cfg, agentStateDir: cfg.agentStateDir, accountScope: null };
}

// 一个最小的假授权服务：只为测试 fetch 那条链路。
async function startAuthority(handler) {
  const server = http.createServer(handler);
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + server.address().port;
  return { base, close: function () { return new Promise(function (r) { server.close(r); }); } };
}

function okPolicy(overrides) {
  return Object.assign({
    ok: true, tenant: TENANT, source: 'server_settings',
    policyRef: { policyId: 'send-policy:' + TENANT, policyVersion: 7 },
    limits: { perUser: 1, hourly: 9, daily: 40, minIntervalMs: 0, activeHours: null },
    observation: { active: false, untilMs: null, dailyLimit: 0 },
    circuit: { failureThreshold: 3, consecutiveFailures: 0 },
    allowedPublicStates: ['sent_confirmed'],
    serverTimeMs: Date.now()
  }, overrides || {});
}

test('S3：没配授权服务时如实标注 local_default，不冒充服务端策略', async function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const out = await health.run(ctx(cfg), {});
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.result.authority.configured, false);
  assert.strictEqual(out.result.quota.sourceOfLimits, 'local_default');
  assert.strictEqual(out.result.quota.hourly, 20, '没接服务端时用本地默认值');
});

test('S3：服务端可达时，上限与服务端策略一致', async function () {
  const fake = await startAuthority(function (request, response) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(okPolicy()));
  });
  try {
    const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
    cfg.authorityUrl = fake.base;
    cfg.authorityToken = TOKEN;
    const out = await health.run(ctx(cfg), {});
    assert.strictEqual(out.ok, true, out.reason);
    assert.strictEqual(out.result.authority.available, true);
    assert.strictEqual(out.result.quota.sourceOfLimits, 'server_policy');
    assert.strictEqual(out.result.quota.hourly, 9, '应当用服务端的小时上限');
    assert.strictEqual(out.result.quota.daily, 40);
    assert.deepStrictEqual(out.result.authority.policyRef, { policyId: 'send-policy:' + TENANT, policyVersion: 7 });
  } finally {
    await fake.close();
  }
});

test('S3（fail-closed）：配了授权服务但连不上 -> canWork=false，绝不退回本地默认', async function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  cfg.authorityUrl = 'http://127.0.0.1:1';   // 必然连不上
  cfg.authorityToken = TOKEN;
  const out = await health.run(ctx(cfg), { probeBrowser: true });
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.result.canWork, false, '服务端不可达时不允许放行');
  assert.strictEqual(out.result.blockedBy, 'blocked/authorization_unavailable');
  assert.strictEqual(out.result.quota.sourceOfLimits, 'unavailable');
  // 关键：不能悄悄用本地默认值继续干活
  assert.strictEqual(out.result.authority.available, false);
});

test('S3（fail-closed）：服务端返回畸形策略，等同于拿不到', async function () {
  const fake = await startAuthority(function (request, response) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, limits: { hourly: 999 } }));  // 没有 policyRef
  });
  try {
    const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
    cfg.authorityUrl = fake.base;
    const out = await health.run(ctx(cfg), { probeBrowser: true });
    assert.strictEqual(out.result.canWork, false);
    assert.strictEqual(out.result.blockedBy, 'blocked/authorization_unavailable');
  } finally {
    await fake.close();
  }
});

test('S3：401 与超时分别给出不同的原因码，都不会被当成"通过"', async function () {
  const fake401 = await startAuthority(function (request, response) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, reason: 'not_authenticated' }));
  });
  try {
    const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
    cfg.authorityUrl = fake401.base;
    const out = await authority.policy(ctx(cfg));
    assert.strictEqual(out.available, false);
    assert.strictEqual(out.reason, 'authorization_not_authenticated');
  } finally {
    await fake401.close();
  }
});

test('S4：冻结计划时把服务端签发的 policyRef 交给 probe（只给身份，不给内容）', async function () {
  const fake = await startAuthority(function (request, response) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(okPolicy({ policyRef: { policyId: 'send-policy:' + TENANT, policyVersion: 12 } })));
  });
  try {
    const recorded = path.join(os.tmpdir(), 'agent-params-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.jsonl');
    const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), {
      accountScope: SCOPE,
      recordParamsTo: recorded,
      methods: { comment_plan: { status: 'ok', batch: { batchId: 'b-1' }, targets: [], blocked: [] } }
    });
    cfg.authorityUrl = fake.base;
    const out = await planBatch.run(ctx(cfg), {
      url: 'https://www.douyin.com/video/1', publicText: '公屏话术', privateText: '私信话术'
    });
    assert.strictEqual(out.ok, true, out.reason);
    assert.strictEqual(out.result.batchId, 'b-1');
    assert.deepStrictEqual(out.result.policyRef, { policyId: 'send-policy:' + TENANT, policyVersion: 12 });
    assert.strictEqual(out.result.candidatesAreSendable, false, '这一层没有发送工具');

    // 真正交给 probe 的参数（假 sidecar 记录到文件的）
    const lines = fs.readFileSync(recorded, 'utf8').trim().split(/\r?\n/).map(function (l) { return JSON.parse(l); });
    const planCall = lines.find(function (l) { return l.method === 'comment_plan'; });
    assert.ok(planCall, '应当调用过 comment_plan');
    const received = planCall.params;
    assert.deepStrictEqual(received.policyRef, { policyId: 'send-policy:' + TENANT, policyVersion: 12 });
    // 🔴 只给身份，绝不给策略内容 —— 给内容 probe 会 policy_not_server_issued 拒掉。
    assert.strictEqual(received.policy, undefined, '不允许把策略内容交给 probe');
    assert.strictEqual(received.limits, undefined);
    assert.strictEqual(received.allowedPublicStates, undefined);
  } finally {
    await fake.close();
  }
});

test('S4（fail-closed）：拿不到服务端策略就不建批次', async function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), {
    accountScope: SCOPE,
    methods: { comment_plan: { status: 'ok', batch: { batchId: 'b-should-not-happen' } } }
  });
  cfg.authorityUrl = 'http://127.0.0.1:1';
  const out = await planBatch.run(ctx(cfg), {
    url: 'https://www.douyin.com/video/1', publicText: 'a', privateText: 'b'
  });
  assert.strictEqual(out.ok, false, '拿不到策略时不该产生任何计划');
  assert.strictEqual(out.code, 'blocked/authorization_unavailable');
});

test('S4：入参校验在开浏览器之前完成', async function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const missingAction = await planBatch.run(ctx(cfg), { url: 'u' });
  assert.strictEqual(missingAction.code, 'blocked/invalid_input');
  const both = await planBatch.run(ctx(cfg), { url: 'u', videoId: 'v', publicText: 'a', privateText: 'b' });
  assert.strictEqual(both.code, 'blocked/invalid_input');
});

test('配置：授权地址与 token 可以用命令行覆盖', function () {
  const config = require('../src/config');
  const cfg = config.fromEnvAndArgs(['--authority-url', 'http://a', '--authority-token', 't'], {});
  assert.strictEqual(cfg.authorityUrl, 'http://a');
  assert.strictEqual(cfg.authorityToken, 't');
  assert.strictEqual(authority.configured(cfg), true);
});
