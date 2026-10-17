'use strict';

const leads = require('../store/leads');
const { callOnce } = require('../sidecar-client');
const { toBlocked } = require('../blocked-codes');

// 采集类工具的公共部分。
//
// 三条纪律：
//   1) sidecar 的终止状态（验证码 / 登录失效）必须【原样抬到最外层】并停止 ——
//      绝不自动重试，绝不绕过验证码；
//   2) 协议错误码一律映射成业务阻断码，不把 sidecar 的码透传给上层；
//   3) 出参里不出现 sec_uid / 昵称原文：身份一律换成本账号内加盐哈希。
//      评论正文【会】返回 —— 那是这几项功能的意义所在；但身份不会。

function fail(code, reason, protocolCode) {
  return { ok: false, code, reason, protocolCode: protocolCode || null };
}

// 采集工具的"停机信号"：命中就停下等人，不做任何补救。
const TERMINAL_STATUS = {
  captcha: { code: 'blocked/captcha_requires_manual_action',
             reason: '页面出现验证码：请人工处理后再重跑（本工具绝不绕过验证码）' },
  captcha_required: { code: 'blocked/captcha_requires_manual_action',
                      reason: '页面出现验证码：请人工处理后再重跑（本工具绝不绕过验证码）' },
  login_required: { code: 'blocked/not_authorized',
                    reason: '登录态失效：请在专用 Chrome 里人工登录后重跑' }
};

function invoke(ctx, method, params) {
  const res = callOnce(ctx.config, method, params || {});
  if (!res.ok) {
    const protocolCode = String((res.error && res.error.code) || 'request_failed');
    return fail(toBlocked(protocolCode),
      String((res.error && res.error.message) || protocolCode), protocolCode);
  }
  const result = res.result || {};
  const status = String(result.status || 'ok');
  const terminal = TERMINAL_STATUS[status];
  if (terminal) {
    // 原样带上 sidecar 的观测，便于使用者判断是页面级还是账号级。
    return Object.assign(fail(terminal.code, terminal.reason, status), { observed: result });
  }
  if (status !== 'ok') {
    // 🔴 真机实测踩过：sidecar 会用 status 表达"这次没干成"
    //    （例如 collect_comments 遇到不支持的页面类型返回 status="unsupported"）。
    //    以前这里只看 ok 就往下走，结果是"ok:true + 0 条"，
    //    调用方会以为"抓到了但没人评论"——那是假的成功。
    //    现在：非 ok 的 status 一律是阻断，并把原始 status 带出去。
    return Object.assign(fail(toBlocked(status),
      'sidecar reported status=' + status, status), { observedStatus: status });
  }
  return { ok: true, result, status };
}

// 账号内加盐哈希。首次使用时建盐：它只存在本机 agent 状态目录里，不是平台凭据。
function identityFor(ctx, accountScope, raw) {
  const value = String(raw == null ? '' : raw);
  if (!value) return null;
  const salt = leads.ensureSalt(ctx.agentStateDir, accountScope);
  return leads.hashSubject(salt, value);
}

// 把一条采集事件投影成可以安全交给上层（可能是个云端模型）的形状。
function maskEvent(ctx, accountScope, event) {
  const row = event || {};
  // 🔴 身份哈希口径必须与线索库一致（import-leads）：
  //    只用 authorId 做加盐哈希，不带 source 前缀。
  //    否则"批次里的候选"和"线索库里的意图"永远对不上，
  //    审批层就没法按意图把投诉挑出来转人工。
  // 🔴 只用 authorId 做哈希。绝不用昵称兜底：
  //    线索库是按 author_id 建键的，用昵称算出来的哈希永远对不上它，
  //    结果就是"批次候选和线索意图永远接不上" —— 投诉也就筛不出来。
  //    没有 authorId 时宁可给 null 并说明原因，也不给一个对不上的哈希。
  const authorId = String(row.authorId == null ? '' : row.authorId).trim();
  return {
    id: String(row.id == null ? '' : row.id),
    source: String(row.source == null ? '' : row.source),
    roomId: String(row.roomId == null ? '' : row.roomId),
    text: String(row.text == null ? '' : row.text),
    observedAt: row.observedAt == null ? null : String(row.observedAt),
    fingerprint: row.fingerprint == null ? null : String(row.fingerprint),
    authorHash: authorId ? identityFor(ctx, accountScope, authorId) : null,
    authorIdentity: authorId ? 'salted_hash_of_author_id' : 'missing_author_id'
  };
}

function maskEvents(ctx, accountScope, events) {
  return (Array.isArray(events) ? events : []).map(function (event) {
    return maskEvent(ctx, accountScope, event);
  });
}

// 批次报告里可能带 authorId 的私信候选：同样只出哈希。
function maskCandidates(ctx, accountScope, candidates) {
  return (Array.isArray(candidates) ? candidates : []).map(function (item) {
    const row = item || {};
    return {
      eventId: String(row.eventId == null ? '' : row.eventId),
      sendId: String(row.sendId == null ? '' : row.sendId),
      publicSendId: row.publicSendId == null ? null : String(row.publicSendId),
      // 同样只用 authorId；缺失就给 null，不拿昵称凑。
      authorHash: String(row.authorId == null ? '' : row.authorId).trim()
        ? identityFor(ctx, accountScope, String(row.authorId).trim()) : null,
      reason: row.reason == null ? null : String(row.reason)
    };
  });
}

// 视频候选的归一到一种形状。
//
// 为什么必须归一：sidecar 的两条路返回的键不一样 ——
//   search       -> { id, url, title, author, authorId, createTime, publishedAt, relevance:{score,reason} }
//   search_pool  -> { videoId, url, title, author, authorId, keyword, relevance:{score,reason}, ... }
// 真机实测踩过：只认 aweme_id / relevance 当数字，结果是 videoId 与相关度全空。
// 创作者 authorId（sec_uid）不出本层。
function normalizeVideo(row) {
  const r = row || {};
  const videoId = r.videoId || r.id || r.aweme_id || '';
  const relevance = r.relevance && typeof r.relevance === 'object' ? r.relevance : null;
  const score = relevance ? relevance.score
    : (r.relevance_score == null ? null : r.relevance_score);
  const reason = relevance ? relevance.reason : (r.relevanceReason == null ? null : r.relevanceReason);
  return {
    videoId: String(videoId),
    url: r.url == null ? null : String(r.url),
    title: r.title == null ? (r.desc == null ? null : String(r.desc)) : String(r.title),
    author: r.author == null ? null : String(r.author),
    relevance: score == null ? null : Number(score),
    relevanceReason: reason == null ? null : String(reason),
    keyword: r.keyword == null ? null : String(r.keyword),
    publishedAt: r.publishedAt == null ? null : String(r.publishedAt)
  };
}

module.exports = {
  fail, invoke, identityFor, maskEvent, maskEvents, maskCandidates,
  normalizeVideo, TERMINAL_STATUS
};
