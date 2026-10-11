'use strict';

const assert = require('node:assert');
const test = require('node:test');

const codes = require('../src/blocked-codes');

// 评审项：业务阻断码与协议错误码是两个命名空间，必须显式映射，
// 且未知码一律收敛到 unknown/*（fail-closed），不得原样透传。

test('闭集枚举固定', function () {
  assert.deepStrictEqual(codes.ACTIONS, ['approve', 'reject', 'skip']);
  assert.ok(codes.INTENTS.indexOf('complaint') !== -1);
  assert.ok(codes.INTENTS.indexOf('irrelevant') !== -1);
  assert.strictEqual(codes.PLATFORM_CONFIRMED, 'sent_confirmed');
  assert.ok(codes.EVIDENCE_STATES.indexOf('sent_echoed') !== -1);
});

const ALLOWED_PREFIXES = ['blocked/', 'empty/', 'unknown/'];

test('已核实的协议码都能映射到闭集里的一个前缀', function () {
  Object.keys(codes.PROTOCOL_TO_BLOCKED).forEach(function (protocolCode) {
    const mapped = codes.toBlocked(protocolCode);
    assert.ok(ALLOWED_PREFIXES.some(function (prefix) { return mapped.indexOf(prefix) === 0; }),
      protocolCode + ' 映射结果不在闭集里: ' + mapped);
  });
});

test('内部类错误收敛到 unknown/*，不外泄协议细节', function () {
  ['invalid_request', 'invalid_config', 'request_too_large', 'unknown_method'].forEach(function (code) {
    assert.strictEqual(codes.toBlocked(code), 'unknown/internal');
  });
});

test('逐个钉住关键映射（评审点名的几条）', function () {
  assert.strictEqual(codes.toBlocked('public_missing'), 'blocked/public_missing');
  assert.strictEqual(codes.toBlocked('public_send_id_mismatch'), 'blocked/public_send_id_mismatch');
  assert.strictEqual(codes.toBlocked('policy_ref_mismatch'), 'blocked/policy_ref_mismatch');
  assert.strictEqual(codes.toBlocked('page_visibility_unknown'), 'blocked/page_visibility_unknown');
  assert.strictEqual(codes.toBlocked('captcha_requires_manual_action'), 'blocked/captcha_requires_manual_action');
  assert.strictEqual(codes.toBlocked('no_replyable_comment'), 'empty/no_replyable_comment');
});

test('未知码不得原样透传', function () {
  assert.strictEqual(codes.toBlocked('something_brand_new'), 'unknown/internal');
  assert.strictEqual(codes.toBlocked(undefined), 'unknown/internal');
});

test('返回体里的 blocked reason 与错误码分开维护', function () {
  assert.strictEqual(codes.RESULT_REASON_TO_BLOCKED.target_has_unresolved_send,
    'blocked/target_has_unresolved_send');
  // 它【不是】错误码，所以不能出现在协议码表里。
  assert.strictEqual(codes.PROTOCOL_TO_BLOCKED.target_has_unresolved_send, undefined);
});
