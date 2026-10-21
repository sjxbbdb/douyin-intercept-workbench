'use strict';

const assert = require('node:assert');
const test = require('node:test');

const leads = require('../src/store/leads');
const queryLeads = require('../src/tools/query_leads');
const helpers = require('./helpers');

// 评审项：隐私红线 —— 只出加盐哈希与计数，绝不外泄 sec_uid / 昵称 / 评论原文。

const SCOPE = 'testscope000000000000000000000000';

function ctxFor(cfg) {
  return { config: cfg, agentStateDir: cfg.agentStateDir, accountScope: SCOPE };
}

test('白名单投影：行里的 sec_uid / 昵称 / 原文不会出现在结果里', function () {
  const cfg = helpers.makeConfig();
  helpers.writeLeads(cfg, SCOPE, [{
    leadId: 'hash-1',
    sourceType: 'comment',
    intent: 'purchase_intent',
    region: '南京',
    firstSeenMs: 1000,
    lastSeenMs: 2000,
    state: 'seen',
    secUid: 'MS4wLjABAAAA-real-sec-uid',
    nickname: '某位观众',
    text: '这个怎么收费',
    authorName: '某位观众'
  }]);
  const out = queryLeads.run(ctxFor(cfg), {});
  assert.strictEqual(out.ok, true, out.reason);
  const serialized = JSON.stringify(out);
  assert.ok(serialized.indexOf('MS4wLjABAAAA') === -1, 'sec_uid 泄漏了');
  assert.ok(serialized.indexOf('某位观众') === -1, '昵称泄漏了');
  assert.ok(serialized.indexOf('这个怎么收费') === -1, '原文泄漏了');
  assert.deepStrictEqual(Object.keys(out.result.leads[0]).sort(),
    ['firstSeenMs', 'intent', 'lastSeenMs', 'leadId', 'region', 'sourceType', 'state']);
});

test('limit 上限不可由调用方扩大', function () {
  const cfg = helpers.makeConfig();
  const tooBig = queryLeads.run(ctxFor(cfg), { limit: 201 });
  assert.strictEqual(tooBig.ok, false);
  assert.strictEqual(tooBig.code, 'blocked/invalid_input');
  assert.ok(tooBig.reason.indexOf('200') !== -1);

  const okLimit = queryLeads.run(ctxFor(cfg), { limit: 200 });
  assert.strictEqual(okLimit.ok, true, okLimit.reason);
});

test('intent 必须是闭集内的值', function () {
  const cfg = helpers.makeConfig();
  const bad = queryLeads.run(ctxFor(cfg), { intent: '想买' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, 'blocked/invalid_input');
  const good = queryLeads.run(ctxFor(cfg), { intent: 'complaint' });
  assert.strictEqual(good.ok, true, good.reason);
});

test('坏行被跳过，不影响其余查询', function () {
  const cfg = helpers.makeConfig();
  const dir = require('node:path').join(cfg.agentStateDir, 'accounts', SCOPE);
  require('node:fs').mkdirSync(dir, { recursive: true });
  require('node:fs').writeFileSync(require('node:path').join(dir, 'leads.jsonl'),
    '{ this is not json }\n' + JSON.stringify({ leadId: 'ok-1', intent: 'unknown' }) + '\n', 'utf8');
  const out = queryLeads.run(ctxFor(cfg), {});
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.result.leads.length, 1);
  assert.strictEqual(out.result.leads[0].leadId, 'ok-1');
});

test('线索文件不存在时返回空，而不是报错', function () {
  const cfg = helpers.makeConfig();
  const out = queryLeads.run(ctxFor(cfg), {});
  assert.strictEqual(out.ok, true, out.reason);
  assert.deepStrictEqual(out.result.leads, []);
  assert.strictEqual(out.result.source, 'empty');
});

test('加盐哈希跨账号不可关联、同账号稳定', function () {
  const cfgA = helpers.makeConfig();
  const cfgB = helpers.makeConfig();
  const saltA = leads.ensureSalt(cfgA.agentStateDir, SCOPE);
  const saltB = leads.ensureSalt(cfgB.agentStateDir, SCOPE);
  const h1 = leads.hashSubject(saltA, 'comment:author-1');
  const h2 = leads.hashSubject(saltA, 'comment:author-1');
  const h3 = leads.hashSubject(saltB, 'comment:author-1');
  assert.strictEqual(h1, h2, '同账号内必须稳定');
  assert.notStrictEqual(h1, h3, '跨账号必须不可关联');
});
