'use strict';

const assert = require('node:assert');
const test = require('node:test');

const ledger = require('../src/ledger');
const helpers = require('./helpers');

// 评审项：Agent 判"已发送"必须看【落库原始状态】。
// send_gate.result() 故意把 sent_confirmed 投影成 unknown，只读台账不能走那条路。

const SCOPE = 'testscope000000000000000000000000';

test('已用额度与 send_gate.py 同口径（滚动窗口 + 只算 4 个状态）', function () {
  const cfg = helpers.makeConfig();
  const now = Date.now();
  helpers.seedSends(cfg, [
    { accountScope: SCOPE, sendId: 's1', targetKey: 'A', status: 'reserved', createdAtMs: now - 10 * 60 * 1000 },
    { accountScope: SCOPE, sendId: 's2', targetKey: 'A', status: 'started', createdAtMs: now - 20 * 60 * 1000 },
    { accountScope: SCOPE, sendId: 's3', targetKey: 'B', status: 'unknown', createdAtMs: now - 30 * 60 * 1000 },
    { accountScope: SCOPE, sendId: 's4', targetKey: 'C', status: 'sent_confirmed', createdAtMs: now - 40 * 60 * 1000 },
    // 2 小时前：不进小时窗口，进日窗口
    { accountScope: SCOPE, sendId: 's5', targetKey: 'C', status: 'sent_confirmed', createdAtMs: now - 2 * 60 * 60 * 1000 },
    // failed/blocked 不计数（与 _quota_used 一致：只算 reserved/started/unknown/sent_confirmed）
    { accountScope: SCOPE, sendId: 's6', status: 'failed', createdAtMs: now - 5 * 60 * 1000 },
    { accountScope: SCOPE, sendId: 's7', status: 'blocked', createdAtMs: now - 5 * 60 * 1000 },
    // 别的账号：一律不计
    { accountScope: 'other', sendId: 's8', status: 'sent_confirmed', createdAtMs: now - 60 * 1000 }
  ]);
  const used = ledger.quotaUsed(cfg.stateDir, SCOPE, now);
  assert.strictEqual(used.ok, true, used.reason);
  assert.strictEqual(used.hourly, 4, '小时窗口应只算近 1 小时的 4 条');
  assert.strictEqual(used.daily, 5, '日窗口应算 5 条（含 2 小时前那条）');
  assert.strictEqual(used.maxPerUser, 2, '同一个 target_key 上最多 2 条（A 两条、C 两条）');
});

test('sendsByStatus 返回原始 sent_confirmed，不做对外投影', function () {
  const cfg = helpers.makeConfig();
  const now = Date.now();
  helpers.seedSends(cfg, [
    { accountScope: SCOPE, sendId: 's1', status: 'sent_confirmed', createdAtMs: now - 60000 },
    { accountScope: SCOPE, sendId: 's2', status: 'unknown', createdAtMs: now - 60000 }
  ]);
  const out = ledger.sendsByStatus(cfg.stateDir, SCOPE, null);
  assert.strictEqual(out.ok, true, out.reason);
  const statuses = out.rows.map(function (r) { return r.status; }).sort();
  assert.deepStrictEqual(statuses, ['sent_confirmed', 'unknown']);
});

test('连续失败数：遇到最近一条成功就停', function () {
  const cfg = helpers.makeConfig();
  const now = Date.now();
  helpers.seedSends(cfg, [
    { accountScope: SCOPE, sendId: 'a1', status: 'failed', createdAtMs: now - 4000, finishedAtMs: now - 4000 },
    { accountScope: SCOPE, sendId: 'a2', status: 'blocked', createdAtMs: now - 3000, finishedAtMs: now - 3000 },
    { accountScope: SCOPE, sendId: 'a3', status: 'unknown', createdAtMs: now - 2000, finishedAtMs: now - 2000 },
    { accountScope: SCOPE, sendId: 'a4', status: 'sent_confirmed', createdAtMs: now - 1000, finishedAtMs: now - 1000 }
  ]);
  const out = ledger.consecutiveFailures(cfg.stateDir, SCOPE, 50);
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.consecutiveFailures, 0, '最近一条是成功，连续失败应为 0');

  const cfg2 = helpers.makeConfig();
  helpers.seedSends(cfg2, [
    { accountScope: SCOPE, sendId: 'b1', status: 'failed', createdAtMs: now - 3000, finishedAtMs: now - 3000 },
    { accountScope: SCOPE, sendId: 'b2', status: 'blocked', createdAtMs: now - 2000, finishedAtMs: now - 2000 },
    { accountScope: SCOPE, sendId: 'b3', status: 'unknown', createdAtMs: now - 1000, finishedAtMs: now - 1000 }
  ]);
  const out2 = ledger.consecutiveFailures(cfg2.stateDir, SCOPE, 50);
  assert.strictEqual(out2.consecutiveFailures, 3);
});

test('台账缺失时报 state_unavailable，不猜', function () {
  const cfg = helpers.makeConfig();
  const used = ledger.quotaUsed(cfg.stateDir, SCOPE, Date.now());
  assert.strictEqual(used.ok, false);
  assert.strictEqual(used.code, 'unknown/state_unavailable');
});

test('队列状态按 schema 读得到（comment_flow 与 live_flow 表名相同）', function () {
  const cfg = helpers.makeConfig();
  const now = Date.now();
  helpers.seedQueue(cfg, 'comment', SCOPE,
    [{ eventKey: 'k1', eventId: 'e1', state: 'sent_confirmed', seenAtMs: now },
     { eventKey: 'k2', eventId: 'e2', state: 'unknown', seenAtMs: now }],
    [{ batchId: 'b1', status: 'open', createdAtMs: now, expiresAtMs: now + 600000 }]);
  const out = ledger.queueStates(cfg.stateDir, 'comment', SCOPE);
  assert.strictEqual(out.ok, true, out.reason);
  assert.strictEqual(out.events.sent_confirmed, 1);
  assert.strictEqual(out.events.unknown, 1);
  assert.strictEqual(out.batches.open, 1);
});
