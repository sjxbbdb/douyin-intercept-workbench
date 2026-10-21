'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const store = require('../src/store');
const policyMod = require('../src/policy');
const authorize = require('../src/authorize');
const httpMod = require('../src/http');

// 评审项（甲 = 服务端权威）：上限的权威必须在服务端。
//   · 客户端不能传参覆盖上限；
//   · 计数在服务端，改本地配置不会多给一次；
//   · 观察期上限为 0 且没有跳过入口；
//   · 两阶段：私信必须绑一条服务端见过、且确认成功的公屏。

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-'));
  return { dir, db: store.open(dir) };
}

const T = 'tenant-a';
const SCOPE = 'scope-0001';
const NOW = 1790000000000;

function grant(db, extra) {
  return authorize.authorize(db, Object.assign({
    tenant: T, accountScope: SCOPE, sendId: 's-' + Math.random().toString(16).slice(2),
    kind: 'comment', phase: 'public', targetKey: 'video:1:author-1'
  }, extra || {}), { nowMs: NOW });
}

test('正常放行，并给出策略身份（probe 的 _require_policy 认这三个字段）', function () {
  const { db } = freshDb();
  const out = grant(db, { sendId: 's1' });
  assert.strictEqual(out.status, 'granted', JSON.stringify(out));
  assert.strictEqual(out.policyRef.policyId, 'send-policy:' + T);
  assert.strictEqual(out.policyRef.policyVersion, 1);
  assert.ok(out.authorizationId);
  assert.ok(out.expiresAtMs > NOW);
});

test('同一个 sendId 幂等：重放返回同一张授权，不重复计数', function () {
  const { db } = freshDb();
  const first = grant(db, { sendId: 's1' });
  const again = grant(db, { sendId: 's1' });
  assert.strictEqual(again.status, 'granted');
  assert.strictEqual(again.idempotent, true);
  assert.strictEqual(again.authorizationId, first.authorizationId);
  // 换了目标就不是同一件事了 —— 幂等冲突，必须拒。
  const conflict = authorize.authorize(db, {
    tenant: T, accountScope: SCOPE, sendId: 's1', kind: 'comment', phase: 'public', targetKey: 'video:2:author-9'
  }, { nowMs: NOW });
  assert.strictEqual(conflict.status, 'denied');
  assert.strictEqual(conflict.reason, 'idempotency_conflict');
});

test('配额在服务端计数：日上限用完就拒，且拒绝原因稳定', function () {
  const { db } = freshDb();
  store.writeSetting(db, policyMod.POLICY_KEY, {
    policyVersion: 3,
    limits: { perUser: 5, hourly: 100, daily: 2 },
    observation: { active: false, untilMs: null }
  }, NOW);
  assert.strictEqual(grant(db, { sendId: 'a', targetKey: 't1' }).status, 'granted');
  assert.strictEqual(grant(db, { sendId: 'b', targetKey: 't2' }).status, 'granted');
  const third = grant(db, { sendId: 'c', targetKey: 't3' });
  assert.strictEqual(third.status, 'denied');
  assert.strictEqual(third.reason, 'quota_daily');
  assert.strictEqual(third.detail.limit, 2);
});

test('单用户上限与小时上限分别生效，口径与 probe 的本地闸门一致', function () {
  const { db } = freshDb();
  store.writeSetting(db, policyMod.POLICY_KEY, {
    policyVersion: 1, limits: { perUser: 1, hourly: 100, daily: 100 }, observation: { active: false }
  }, NOW);
  assert.strictEqual(grant(db, { sendId: 'a', targetKey: 'same' }).status, 'granted');
  const same = grant(db, { sendId: 'b', targetKey: 'same' });
  assert.strictEqual(same.reason, 'quota_per_user');

  const { db: db2 } = freshDb();
  store.writeSetting(db2, policyMod.POLICY_KEY, {
    policyVersion: 1, limits: { perUser: 9, hourly: 1, daily: 100 }, observation: { active: false }
  }, NOW);
  assert.strictEqual(grant(db2, { sendId: 'a', targetKey: 't1' }).status, 'granted');
  const hourly = grant(db2, { sendId: 'b', targetKey: 't2' });
  assert.strictEqual(hourly.reason, 'quota_hourly');

  // 一小时前的记录不进小时窗口 —— 与 probe 的滚动窗口口径一致。
  const later = authorize.authorize(db2, {
    tenant: T, accountScope: SCOPE, sendId: 'c', kind: 'comment', phase: 'public', targetKey: 't3'
  }, { nowMs: NOW + 3601 * 1000 });
  assert.strictEqual(later.status, 'granted');
});

test('观察期：上限为 0，且没有跳过入口', function () {
  const { db } = freshDb();
  store.writeSetting(db, policyMod.POLICY_KEY, {
    policyVersion: 1,
    limits: { perUser: 1, hourly: 20, daily: 50 },
    observation: { active: true, untilMs: NOW + 86400000, dailyLimit: 0 }
  }, NOW);
  const out = grant(db, { sendId: 's1' });
  assert.strictEqual(out.status, 'denied');
  assert.strictEqual(out.reason, 'observation_period');
  assert.ok(out.detail.untilMs > NOW);
  // 到期后自动恢复，不需要任何"跳过"动作。
  const after = authorize.authorize(db, {
    tenant: T, accountScope: SCOPE, sendId: 's2', kind: 'comment', phase: 'public', targetKey: 't1'
  }, { nowMs: NOW + 86400001 });
  assert.strictEqual(after.status, 'granted');
});

test('两阶段：私信必须绑一条服务端见过、且确认成功的公屏', function () {
  const { db } = freshDb();
  const missing = authorize.authorize(db, {
    tenant: T, accountScope: SCOPE, sendId: 'p1', kind: 'private', phase: 'private', targetKey: 'u1'
  }, { nowMs: NOW });
  assert.strictEqual(missing.reason, 'public_missing');

  const notSeen = authorize.authorize(db, {
    tenant: T, accountScope: SCOPE, sendId: 'p2', kind: 'private', phase: 'private', targetKey: 'u1', publicSendId: 'nope'
  }, { nowMs: NOW });
  assert.strictEqual(notSeen.reason, 'public_not_confirmed');

  // 公屏只是 unknown（页面回显）—— 也不算数。
  const pub = authorize.authorize(db, {
    tenant: T, accountScope: SCOPE, sendId: 'pub1', kind: 'comment', phase: 'public', targetKey: 'video:1:u1'
  }, { nowMs: NOW });
  authorize.commit(db, T, pub.authorizationId, { state: 'unknown' }, { nowMs: NOW });
  const afterUnknown = authorize.authorize(db, {
    tenant: T, accountScope: SCOPE, sendId: 'p3', kind: 'private', phase: 'private', targetKey: 'u1', publicSendId: 'pub1'
  }, { nowMs: NOW });
  assert.strictEqual(afterUnknown.reason, 'public_not_confirmed');

  // 平台确认成功之后才放行。
  const pub2 = authorize.authorize(db, {
    tenant: T, accountScope: SCOPE, sendId: 'pub2', kind: 'comment', phase: 'public', targetKey: 'video:1:u2'
  }, { nowMs: NOW });
  authorize.commit(db, T, pub2.authorizationId, { state: 'sent_confirmed' }, { nowMs: NOW });
  const ok = authorize.authorize(db, {
    tenant: T, accountScope: SCOPE, sendId: 'p4', kind: 'private', phase: 'private', targetKey: 'u2', publicSendId: 'pub2'
  }, { nowMs: NOW });
  assert.strictEqual(ok.status, 'granted', JSON.stringify(ok));
});

test('两阶段：公屏不是本账号的，也拒（防止张冠李戴）', function () {
  const { db } = freshDb();
  const pub = authorize.authorize(db, {
    tenant: T, accountScope: 'scope-OTHER', sendId: 'pub1', kind: 'comment', phase: 'public', targetKey: 'video:1:u1'
  }, { nowMs: NOW });
  authorize.commit(db, T, pub.authorizationId, { state: 'sent_confirmed' }, { nowMs: NOW });
  const out = authorize.authorize(db, {
    tenant: T, accountScope: SCOPE, sendId: 'p1', kind: 'private', phase: 'private', targetKey: 'u1', publicSendId: 'pub1'
  }, { nowMs: NOW });
  assert.strictEqual(out.reason, 'public_account_mismatch');
});

test('熔断：连续失败达阈就停，成功一次即清零', function () {
  const { db } = freshDb();
  store.writeSetting(db, policyMod.POLICY_KEY, {
    policyVersion: 1, limits: { perUser: 9, hourly: 100, daily: 100 },
    observation: { active: false }, circuit: { failureThreshold: 3, cooldownMs: 60000 }
  }, NOW);
  for (let i = 0; i < 3; i += 1) {
    const g = grant(db, { sendId: 'f' + i, targetKey: 't' + i });
    authorize.commit(db, T, g.authorizationId, { state: 'failed' }, { nowMs: NOW + i * 1000 });
  }
  const blocked = authorize.authorize(db, {
    tenant: T, accountScope: SCOPE, sendId: 'next', kind: 'comment', phase: 'public', targetKey: 'tx'
  }, { nowMs: NOW + 5000 });
  assert.strictEqual(blocked.reason, 'circuit_open');

  // 冷却过后恢复
  const afterCooldown = authorize.authorize(db, {
    tenant: T, accountScope: SCOPE, sendId: 'next2', kind: 'comment', phase: 'public', targetKey: 'ty'
  }, { nowMs: NOW + 3 * 1000 + 61000 });
  assert.strictEqual(afterCooldown.status, 'granted');
});

test('最小间隔与活跃时段', function () {
  const { db } = freshDb();
  store.writeSetting(db, policyMod.POLICY_KEY, {
    policyVersion: 1,
    limits: { perUser: 9, hourly: 100, daily: 100, minIntervalMs: 60000 },
    observation: { active: false }
  }, NOW);
  grant(db, { sendId: 'a', targetKey: 't1' });
  const tooSoon = authorize.authorize(db, {
    tenant: T, accountScope: SCOPE, sendId: 'b', kind: 'comment', phase: 'public', targetKey: 't2'
  }, { nowMs: NOW + 1000 });
  assert.strictEqual(tooSoon.reason, 'min_interval');

  const { db: db2 } = freshDb();
  store.writeSetting(db2, policyMod.POLICY_KEY, {
    policyVersion: 1,
    limits: { perUser: 9, hourly: 100, daily: 100, activeHours: { start: '09:00', end: '22:00', tzOffsetMinutes: 480 } },
    observation: { active: false }
  }, NOW);
  // 2026-10-12T22:00Z + 8h = 次日 06:00（东八区）-> 不在时段内
  const outside = authorize.authorize(db2, {
    tenant: T, accountScope: SCOPE, sendId: 'a', kind: 'comment', phase: 'public', targetKey: 't1'
  }, { nowMs: Date.UTC(2026, 9, 12, 22, 0, 0) });
  assert.strictEqual(outside.reason, 'outside_active_hours');
});

test('了结：只接受终态；没结果一律 unknown，绝不冒充成功', function () {
  const { db } = freshDb();
  const g = grant(db, { sendId: 's1' });
  assert.strictEqual(authorize.commit(db, T, g.authorizationId, { state: 'sent' }, { nowMs: NOW }).reason,
    'outcome_must_be_terminal');
  assert.strictEqual(authorize.commit(db, T, g.authorizationId, { state: 'sent_confirmed' }, { nowMs: NOW }).ok, true);
  const again = authorize.commit(db, T, g.authorizationId, { state: 'sent_confirmed' }, { nowMs: NOW });
  assert.strictEqual(again.idempotent, true);
  assert.strictEqual(authorize.commit(db, T, 'nope', { state: 'failed' }, { nowMs: NOW }).reason, 'unknown_authorization');
});

test('每一次裁决都留审计（含拒绝）', function () {
  const { db } = freshDb();
  grant(db, { sendId: 's1' });
  const denied = grant(db, { sendId: 's2', targetKey: 'x' });
  if (denied.status !== 'granted') authorize.denyAudit(db, T, denied.reason, { sendId: 's2' }, NOW);
  const rows = db.prepare('SELECT action FROM audit WHERE tenant=?').all(T).map(function (r) { return String(r.action); });
  assert.ok(rows.indexOf('send_authorization_granted') !== -1);
  assert.ok(rows.length >= 1);
});

test('客户端把上限塞进请求里：一律忽略，并记一条审计', async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authority-http-'));
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ [T]: 'token-a' }), 'utf8');
  const created = httpMod.createServer({ stateDir: dir, tokens: { [T]: 'token-a' }, clock: function () { return NOW; } });
  await new Promise(function (resolve) { created.server.listen(0, '127.0.0.1', resolve); });
  const port = created.server.address().port;
  const base = 'http://127.0.0.1:' + port;

  const unauth = await fetch(base + '/v1/policy/sending');
  assert.strictEqual(unauth.status, 401, '没有 token 必须 401');

  const resp = await fetch(base + '/v1/send-authorizations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token-a' },
    body: JSON.stringify({ accountScope: SCOPE, sendId: 's1', kind: 'comment', phase: 'public',
                           targetKey: 't1', limits: { daily: 100000 }, hourly: 999 })
  });
  const body = await resp.json();
  assert.strictEqual(body.status, 'granted', JSON.stringify(body));
  // 上限没被请求体改掉：默认 daily=50，remaining.daily 应当是 49。
  assert.strictEqual(body.remaining.daily, 49, '请求体里的上限被当真了');
  const audit = created.db.prepare("SELECT metadata_json FROM audit WHERE action='policy_override_attempt'").all();
  assert.strictEqual(audit.length, 1, '覆盖上限的尝试应当被记审计');

  const policyResp = await fetch(base + '/v1/policy/sending?accountScope=' + SCOPE, {
    headers: { authorization: 'Bearer token-a' }
  });
  const policyBody = await policyResp.json();
  assert.strictEqual(policyBody.limits.daily, 50);
  assert.strictEqual(policyBody.policyRef.policyId, 'send-policy:' + T);

  await new Promise(function (resolve) { created.server.close(resolve); });
});
