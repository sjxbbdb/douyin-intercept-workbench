'use strict';

const scope = require('../scope');
const capture = require('./_capture');

// 直播间监听一轮：采集可见互动并【并入队列】（按房间/作者/正文去重，容量有上限）。
// 可以反复调用；队列是"接下来的批次从哪儿来"的答案。
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

  const outcome = capture.invoke(ctx, 'live_listen', sent);
  if (!outcome.ok) return outcome;

  const result = outcome.result;
  const events = capture.maskEvents(ctx, resolved.accountScope, result.events);
  return { ok: true, result: {
    ok: true,
    accountScope: resolved.accountScope,
    status: outcome.status,
    collected: events.length,
    events,
    queue: result.queue || null,
    capability: result.capability || null,
    privacy: 'interaction_text_included_author_identity_hashed',
    note: '队列跨调用累积；可以重复监听同一房间'
  } };
}

module.exports = { name: 'live_listen', run };
