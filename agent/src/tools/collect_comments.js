'use strict';

const scope = require('../scope');
const capture = require('./_capture');

// 抓一条视频的评论区，并按关键词/排除词/去重给出目标批次。
//
// 这是"评论区"功能的入口。它【只采集】：不回复、不私信。
// 返回的 targets 是"将来审批阶段要看的候选"，不是可发送的计划 ——
// 本层没有任何发送工具，所以它们出不去。
//
// 隐私：评论正文会返回（否则这项功能没有意义），但作者身份只出加盐哈希。

const MATCH_MODES = ['seg', 'full'];

function run(ctx, params) {
  const p = params || {};
  const hasUrl = typeof p.url === 'string' && p.url.trim();
  const hasVideoId = typeof p.videoId === 'string' && p.videoId.trim();
  if (!hasUrl && !hasVideoId) {
    return capture.fail('blocked/invalid_input', 'one of url / videoId is required');
  }
  if (hasUrl && hasVideoId) {
    return capture.fail('blocked/invalid_input', 'give either url or videoId, not both');
  }
  if (p.matchMode != null && MATCH_MODES.indexOf(String(p.matchMode)) === -1) {
    return capture.fail('blocked/invalid_input', 'matchMode must be one of: ' + MATCH_MODES.join(', '));
  }
  if (p.maxItems != null && (!Number.isInteger(p.maxItems) || p.maxItems < 1 || p.maxItems > 500)) {
    return capture.fail('blocked/invalid_input', 'maxItems must be an integer between 1 and 500');
  }
  if (p.maxTargets != null && (!Number.isInteger(p.maxTargets) || p.maxTargets < 1 || p.maxTargets > 500)) {
    return capture.fail('blocked/invalid_input', 'maxTargets must be an integer between 1 and 500');
  }
  const resolved = scope.resolve(ctx);
  if (!resolved.ok) return resolved;

  const sent = {};
  ['url', 'videoId', 'commentKeywords', 'excludeKeywords', 'matchMode',
   'minDigg', 'maxTargets', 'dedupeAuthors', 'maxItems', 'scrollRounds'].forEach(function (key) {
    if (p[key] != null) sent[key] = p[key];
  });

  const outcome = capture.invoke(ctx, 'collect_comments', sent);
  if (!outcome.ok) return outcome;

  const result = outcome.result;
  const events = capture.maskEvents(ctx, resolved.accountScope, result.events);
  const targets = capture.maskEvents(ctx, resolved.accountScope, result.targets);
  return { ok: true, result: {
    ok: true,
    accountScope: resolved.accountScope,
    status: outcome.status,
    collected: events.length,
    matched: targets.length,
    events,
    // 候选：BP0 只能看，不能发。等审批层（BP1）落地后才谈得上"用"。
    candidates: targets,
    candidatesAreSendable: false,
    filter: result.filter || null,
    capability: result.capability || null,
    privacy: 'comment_text_included_author_identity_hashed'
  } };
}

module.exports = { name: 'collect_comments', run };
