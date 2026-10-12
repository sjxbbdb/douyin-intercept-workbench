'use strict';

const capture = require('./_capture');

// 看已抓到的候选视频（本地池子，只读、不碰浏览器）。
// 存在的意义：search 每次只返回一页，池子才是"这次搜索到底有哪些候选"的答案。
function run(ctx, params) {
  const p = params || {};
  if (p.limit != null && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 1000)) {
    return capture.fail('blocked/invalid_input', 'limit must be an integer between 1 and 1000');
  }
  if (p.keyword != null && typeof p.keyword !== 'string') {
    return capture.fail('blocked/invalid_input', 'keyword must be a string');
  }
  const sent = {};
  ['keyword', 'minRelevance', 'limit'].forEach(function (key) {
    if (p[key] != null) sent[key] = p[key];
  });
  const outcome = capture.invoke(ctx, 'search_pool', sent);
  if (!outcome.ok) return outcome;

  const result = outcome.result;
  const videos = (Array.isArray(result.videos) ? result.videos : []).map(capture.normalizeVideo);
  return { ok: true, result: {
    ok: true,
    status: outcome.status,
    videos,
    stats: result.stats || null,
    note: '视频作者是公开内容元信息；创作者 sec_uid 不出本层'
  } };
}

module.exports = { name: 'list_video_pool', run };
