'use strict';

const scope = require('../scope');
const capture = require('./_capture');

// 抓一个直播间的可见互动（弹幕/进场等）。
//
// 与 live_listen 的区别：本工具【只看这一次】，不入队；
// live_listen 会把结果并进队列，为将来的批次做准备。
function run(ctx, params) {
  const p = params || {};
  if (typeof p.url !== 'string' || !p.url.trim()) {
    return capture.fail('blocked/invalid_input', 'url is required (https://live.douyin.com/...)');
  }
  if (p.maxItems != null && (!Number.isInteger(p.maxItems) || p.maxItems < 1 || p.maxItems > 500)) {
    return capture.fail('blocked/invalid_input', 'maxItems must be an integer between 1 and 500');
  }
  const resolved = scope.resolve(ctx);
  if (!resolved.ok) return resolved;

  const sent = { url: p.url };
  if (p.maxItems != null) sent.maxItems = p.maxItems;

  const outcome = capture.invoke(ctx, 'collect_live', sent);
  if (!outcome.ok) return outcome;

  const result = outcome.result;
  const events = capture.maskEvents(ctx, resolved.accountScope, result.events);
  return { ok: true, result: {
    ok: true,
    accountScope: resolved.accountScope,
    status: outcome.status,
    collected: events.length,
    events,
    capability: result.capability || null,
    privacy: 'interaction_text_included_author_identity_hashed',
    note: '只采集可见互动；本层不发送任何内容'
  } };
}

module.exports = { name: 'collect_live', run };
