'use strict';

const assert = require('node:assert');
const test = require('node:test');

const health = require('../src/tools/get_account_health');
const stats = require('../src/tools/get_stats');
const explain = require('../src/tools/explain_failure');
const helpers = require('./helpers');

// 评审项：canWork 是"能否干活"的唯一依据，且必须 fail-closed。

const SCOPE = 'testscope000000000000000000000000';

function ctx(cfg) {
  return { config: cfg, agentStateDir: cfg.agentStateDir, accountScope: null };
}

test('没显式探查浏览器时 canWork=false，并说明是没查而不是不能用', async function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const out = await health.run(ctx(cfg), {});
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.result.canWork, false);
  assert.strictEqual(out.result.blockedBy, 'unknown/browser_not_probed');
  assert.deepStrictEqual(out.result.checked, ['quota', 'circuit']);
  assert.strictEqual(out.result.login, 'unknown');
  assert.strictEqual(out.result.accountScope, SCOPE);
  // 熔断来源必须如实标注（probe 并不持久化熔断）
  assert.strictEqual(out.result.circuit.persisted, false);
  assert.strictEqual(out.result.observation.source, 'absent_in_probe');
});

test('探查浏览器且一切正常时 canWork=true，额度读的是台账已用数', async function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE, login: 'ok' });
  const now = Date.now();
  helpers.seedSends(cfg, [
    { accountScope: SCOPE, sendId: 's1', status: 'sent_confirmed', createdAtMs: now - 60000 }
  ]);
  const out = await health.run(ctx(cfg), { probeBrowser: true });
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.result.canWork, true, JSON.stringify(out.result));
  assert.strictEqual(out.result.quota.usedHour, 1);
  assert.strictEqual(out.result.quota.remainingHour, 19);
  // 没有配授权服务时如实标注 local_default，绝不冒充服务端策略。
  assert.strictEqual(out.result.quota.sourceOfLimits, 'local_default');
  assert.strictEqual(out.result.authority.configured, false);
});

test('验证码命中 -> 停机转人工，canWork=false', async function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE, captcha: true });
  const out = await health.run(ctx(cfg), { probeBrowser: true });
  assert.strictEqual(out.result.canWork, false);
  assert.strictEqual(out.result.blockedBy, 'blocked/captcha_requires_manual_action');
});

test('浏览器不属于本侧车 -> 原样报阻断码，不是工具故障', async function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), {
    accountScope: SCOPE,
    doctorError: { code: 'browser_not_owned', message: 'port belongs to someone else' }
  });
  const out = await health.run(ctx(cfg), { probeBrowser: true });
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.result.canWork, false);
  assert.strictEqual(out.result.blockedBy, 'blocked/browser_not_owned');
});

test('额度用尽 -> canWork=false 且指向具体额度', async function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), {
    accountScope: SCOPE, limits: { per_user: 1, hourly: 1, daily: 50 }
  });
  helpers.seedSends(cfg, [
    { accountScope: SCOPE, sendId: 's1', status: 'sent_confirmed', createdAtMs: Date.now() - 60000 }
  ]);
  const out = await health.run(ctx(cfg), { probeBrowser: true });
  assert.strictEqual(out.result.canWork, false);
  assert.strictEqual(out.result.blockedBy, 'blocked/local_quota_hourly');
  assert.strictEqual(out.result.quota.remainingHour, 0);
});

test('sidecar 起不来时 health 报 state_unavailable，不猜', async function () {
  const cfg = helpers.makeConfig(); // 没有写假 sidecar
  const out = await health.run(ctx(cfg), {});
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'unknown/state_unavailable');
});

test('get_stats：sent_confirmed 只来自落库原始状态', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const now = Date.now();
  helpers.seedSends(cfg, [
    { accountScope: SCOPE, sendId: 's1', status: 'sent_confirmed', createdAtMs: now - 60000, kind: 'comment' },
    { accountScope: SCOPE, sendId: 's2', status: 'unknown', createdAtMs: now - 60000, kind: 'private' }
  ]);
  helpers.seedQueue(cfg, 'comment', SCOPE,
    [{ eventKey: 'k1', eventId: 'e1', state: 'sent_confirmed', seenAtMs: now }], []);
  const out = stats.run(ctx(cfg), { groupBy: 'day' });
  assert.strictEqual(out.ok, true, out.reason);
  const groups = Object.values(out.result.groups);
  const counters = groups[0];
  assert.strictEqual(counters.sent_confirmed, 1);
  assert.strictEqual(counters.unknown, 1);
  assert.strictEqual(out.result.sentEchoed, 0);
  assert.strictEqual(out.result.ledger.commentEvents.sent_confirmed, 1);
});

test('get_stats：groupBy 只接受闭集值', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const bad = stats.run(ctx(cfg), { groupBy: '随便' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, 'blocked/invalid_input');
});

test('explain_failure：unknown 一律 nextAction=none（未知不得自动重试）', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const now = Date.now();
  helpers.seedSends(cfg, [
    { accountScope: SCOPE, sendId: 'u1', status: 'unknown', createdAtMs: now - 1000 },
    { accountScope: SCOPE, sendId: 'u2', status: 'started', createdAtMs: now - 1000 },
    { accountScope: SCOPE, sendId: 'u3', status: 'reserved', createdAtMs: now - 1000 },
    { accountScope: SCOPE, sendId: 'c1', status: 'sent_confirmed', createdAtMs: now - 1000 },
    { accountScope: SCOPE, sendId: 'f1', status: 'failed', createdAtMs: now - 1000,
      detail: { reason: 'page_not_ready' } },
    { accountScope: SCOPE, sendId: 'f2', status: 'failed', createdAtMs: now - 1000,
      detail: { reason: 'captcha_requires_manual_action' } }
  ]);
  ['u1', 'u2', 'u3', 'c1'].forEach(function (sendId) {
    const out = explain.run(ctx(cfg), { sendId });
    assert.strictEqual(out.ok, true, out.reason);
    assert.strictEqual(out.result.nextAction, 'none', sendId + ' 不该被允许自动重试');
  });
  const okRetry = explain.run(ctx(cfg), { sendId: 'f1' });
  assert.strictEqual(okRetry.result.nextAction, 'retry_allowed');
  const noRetry = explain.run(ctx(cfg), { sendId: 'f2' });
  assert.strictEqual(noRetry.result.nextAction, 'manual');
  assert.strictEqual(noRetry.result.evidenceState, 'failed');
});

test('explain_failure：台账里的 sec_uid 原文绝不外泄（真机实测发现过的泄漏）', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const SEC_UID = 'MS4wLjABAAAAgy1IqwTz0xU2zIAYK9Xu58PXZPpYdQg_IkUoA8EeDxvGjtah-w_foWR4Jj6MPC0S';
  helpers.seedSends(cfg, [
    { accountScope: SCOPE, sendId: 'k1', targetKey: 'video:7662944089931989811:' + SEC_UID,
      status: 'sent_confirmed', createdAtMs: Date.now() - 1000 }
  ]);
  // 先建盐（正常部署里 import-leads 会建），再查。
  require('../src/store/leads').ensureSalt(cfg.agentStateDir, SCOPE);
  const out = explain.run(ctx(cfg), { sendId: 'k1' });
  assert.strictEqual(out.ok, true, out.reason);
  const serialized = JSON.stringify(out);
  assert.ok(serialized.indexOf(SEC_UID) === -1, 'targetKey 把 sec_uid 带出来了');
  assert.ok(serialized.indexOf('7662944089931989811') === -1, 'targetKey 把视频标识带出来了');
  assert.ok(out.result.subject.targetIdentityHash, '应当给出加盐哈希');

  // 没有盐时：宁可不给这个字段，也不原样透传。
  const cfg2 = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  helpers.seedSends(cfg2, [
    { accountScope: SCOPE, sendId: 'k2', targetKey: 'video:1:' + SEC_UID,
      status: 'unknown', createdAtMs: Date.now() - 1000 }
  ]);
  const out2 = explain.run(ctx(cfg2), { sendId: 'k2' });
  assert.ok(JSON.stringify(out2).indexOf(SEC_UID) === -1, '没有盐时泄漏了 sec_uid');
  assert.strictEqual(out2.result.subject.targetIdentityHash, null);
});

test('explain_failure：event_key（房间+作者+正文）同样要哈希', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  helpers.seedQueue(cfg, 'comment', SCOPE,
    [{ eventKey: 'room-1|author-9|这个怎么收费', eventId: 'e9', state: 'sent_confirmed', seenAtMs: Date.now() }],
    []);
  require('../src/store/leads').ensureSalt(cfg.agentStateDir, SCOPE);
  const out = explain.run(ctx(cfg), { eventId: 'e9' });
  assert.strictEqual(out.ok, true, out.reason);
  const serialized = JSON.stringify(out);
  assert.ok(serialized.indexOf('这个怎么收费') === -1, 'event_key 把评论原文带出来了');
  assert.ok(out.result.subject.eventIdentityHash);
});

test('explain_failure：查不到也不等于失败，nextAction=none', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  helpers.seedSends(cfg, []); // 台账存在但为空
  const out = explain.run(ctx(cfg), { sendId: 'nope' });
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.result.reasonCode, 'send_id_not_found');
  assert.strictEqual(out.result.nextAction, 'none');
});

test('explain_failure：台账缺失时 fail-closed，不假装查过了', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const out = explain.run(ctx(cfg), { sendId: 'nope' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'unknown/state_unavailable');
});

test('explain_failure：不给任何查询键就报 invalid_input', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const out = explain.run(ctx(cfg), {});
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'blocked/invalid_input');
});
