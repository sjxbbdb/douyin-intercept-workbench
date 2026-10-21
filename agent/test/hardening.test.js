'use strict';

const assert = require('node:assert');
const test = require('node:test');

const allowlist = require('../src/sidecar-allowlist');
const sidecarClient = require('../src/sidecar-client');
const leads = require('../src/store/leads');
const capture = require('../src/tools/_capture');
const helpers = require('./helpers');

// 评审项：这两条是"修过但不够硬"的地方，各补一条钉住。
//
//   1) 身份哈希：只用 authorId。绝不用昵称兜底 —— 兜底出来的哈希
//      永远对不上线索库（那边只按 author_id 建键），投诉就筛不出来。
//   2) 越权闸门：必须在【运行时】拦，不能只靠扫源码。
//      扫源码挡不住双引号写法，也挡不住算出来的方法名。

const SCOPE = 'testscope000000000000000000000000';

function ctx(cfg) {
  return { config: cfg, agentStateDir: cfg.agentStateDir, accountScope: null };
}

test('运行时闸门：白名单外的方法根本发不出去（连进程都不起）', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  ['send_private', 'comment_private', 'send_comment', 'open', 'live_private', 'live_plan'].forEach(function (method) {
    const out = sidecarClient.callOnce(cfg, method, {});
    assert.strictEqual(out.ok, false, method + ' 竟然被放行了');
    assert.ok(String(out.error.code).length > 0);
    assert.ok(out.error.message.indexOf(method) !== -1, '拒绝原因要能指出是哪个方法');
  });
});

test('运行时闸门：双引号写法也拦得住（静态扫描挡不住的那种）', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const method = ["send", "private"].join("_");   // 算出来的方法名
  const out = sidecarClient.callOnce(cfg, method, {});
  assert.strictEqual(out.ok, false);
});

test('运行时闸门：白名单内的方法照常放行', function () {
  const cfg = helpers.writeFakeSidecar(helpers.makeConfig(), { accountScope: SCOPE });
  const out = sidecarClient.callOnce(cfg, 'capabilities', {});
  assert.strictEqual(out.ok, true, JSON.stringify(out.error));
});

test('身份哈希与线索库【同一个口径】：同一个 authorId 算出同一个值', function () {
  const cfg = helpers.makeConfig();
  const salt = leads.ensureSalt(cfg.agentStateDir, SCOPE);
  const authorId = 'MS4wLjABAAAA-某个真实-sec-uid';
  // 线索库这一侧（import-leads 用的是同一个函数）
  const leadId = leads.hashSubject(salt, authorId);
  // 事件这一侧
  const masked = capture.maskEvent(ctx(cfg), SCOPE, {
    id: 'c1', source: 'video', roomId: 'v1', text: '多少钱', authorId: authorId
  });
  assert.strictEqual(masked.authorHash, leadId, '两侧哈希必须相等，否则候选永远对不上意图');
  assert.strictEqual(masked.authorIdentity, 'salted_hash_of_author_id');
});

test('没有 authorId 时不给哈希，也不拿昵称凑', function () {
  const cfg = helpers.makeConfig();
  const masked = capture.maskEvent(ctx(cfg), SCOPE, {
    id: 'c1', source: 'video', roomId: 'v1', text: '多少钱', authorId: '', authorName: '某个观众'
  });
  assert.strictEqual(masked.authorHash, null, '没有 authorId 就不该产生哈希');
  assert.strictEqual(masked.authorIdentity, 'missing_author_id',
    '用昵称算出来的哈希对不上线索库，等于埋一个永远匹配不上的坑');
});

test('候选清单里的身份同样只用 authorId', function () {
  const cfg = helpers.makeConfig();
  const salt = leads.ensureSalt(cfg.agentStateDir, SCOPE);
  const authorId = 'MS4wLjABAAAA-another';
  const masked = capture.maskCandidates(ctx(cfg), SCOPE, [
    { eventId: 'e1', sendId: 's1', publicSendId: 'p1', authorId: authorId },
    { eventId: 'e2', sendId: 's2', authorId: '', authorName: '某人' }
  ]);
  assert.strictEqual(masked[0].authorHash, leads.hashSubject(salt, authorId));
  assert.strictEqual(masked[1].authorHash, null);
});

test('白名单与禁止清单不重叠，且禁止清单里的方法一定不在白名单里', function () {
  allowlist.FORBIDDEN_SIDECAR_METHODS.forEach(function (method) {
    assert.strictEqual(allowlist.ALLOWED_SIDECAR_METHODS.indexOf(method), -1,
      method + ' 同时出现在白名单和禁止清单里');
  });
  // execute 层在【白名单内】（approve_batch 要用），单发入口在禁止清单里。
  assert.strictEqual(allowlist.check('comment_reply'), null, 'comment_reply 属于 execute 层，应当放行');
  assert.ok(allowlist.check('send_private'), 'send_private 必须被拦');
});
