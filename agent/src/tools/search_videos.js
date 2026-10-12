'use strict';

const scope = require('../scope');
const capture = require('./_capture');

// 关键词找视频（分页）。
//
// 模块边界：只负责【发现与筛选】视频 —— 不回复评论、不私信。
// 相关度衡量的是标题与关键词的【字面相关】，不是视频质量。

const MAX_KEYWORD = 120;

function run(ctx, params) {
  const p = params || {};
  const keyword = typeof p.keyword === 'string' ? p.keyword.trim() : '';
  if (!keyword) return capture.fail('blocked/invalid_input', 'keyword is required');
  if (keyword.length > MAX_KEYWORD) {
    return capture.fail('blocked/invalid_input', 'keyword must not exceed ' + MAX_KEYWORD + ' characters');
  }
  if (p.maxVideos != null && (!Number.isInteger(p.maxVideos) || p.maxVideos < 1 || p.maxVideos > 200)) {
    return capture.fail('blocked/invalid_input', 'maxVideos must be an integer between 1 and 200');
  }
  if (p.minRelevance != null && (!Number.isInteger(p.minRelevance) || p.minRelevance < 0 || p.minRelevance > 100)) {
    return capture.fail('blocked/invalid_input', 'minRelevance must be an integer between 0 and 100');
  }
  const resolved = scope.resolve(ctx);
  if (!resolved.ok) return resolved;

  const sent = { keyword: keyword };
  ['maxVideos', 'scrollRounds', 'cursor', 'dateFrom', 'dateTo', 'minRelevance'].forEach(function (key) {
    if (p[key] != null) sent[key] = p[key];
  });
  const outcome = capture.invoke(ctx, 'search', sent);
  if (!outcome.ok) return outcome;

  const result = outcome.result;
  // 视频作者是公开的内容元信息（保留，使用者要据此挑视频）；
  // 创作者 sec_uid / authorId 一律不出本层。
  const videos = (Array.isArray(result.videos) ? result.videos : []).map(capture.normalizeVideo);

  return { ok: true, result: {
    ok: true,
    accountScope: resolved.accountScope,
    status: outcome.status,
    keyword,
    videos,
    cursor: result.cursor == null ? null : String(result.cursor),
    hasMore: Boolean(result.hasMore),
    page: result.page == null ? null : Number(result.page),
    poolSize: result.poolSize == null ? null : Number(result.poolSize),
    skippedSeen: result.skippedSeen == null ? null : Number(result.skippedSeen),
    filter: result.filter || null,
    nextStep: '把 videoId 交给 collect_comments 抓评论区；池子内容可用 list_video_pool 复查'
  } };
}

module.exports = { name: 'search_videos', run };
