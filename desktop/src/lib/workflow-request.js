'use strict';

// 任务面板/Agent 聊天的【结构化流程请求】。
//
// 为什么需要这一层（平台契约，看 server/src/workflow-routes.ts:375-389）：
//   流程实例必须绑定一张【服务端签发】的计划（workflow_plans：status=issued、未过期，
//   且 params 与提交值完全一致），客户端不能自己造 planId/params —— 服务端是唯一权威。
//   所以"任务面板点一下就跑直播批次"不能走"客户端拼计划"，只能是：
//     结构化请求 -> 平台规划（/v1/agent/plan）-> 桌面端【逐项核对返回的计划】-> 才启动。
//   核对不过就拒绝启动（fail-closed），绝不"跑一个差不多的流程"。

const WORKFLOW_IDS = Object.freeze({
  'live.batch': Object.freeze({ version: '1', required: ['url', 'keywords'], kind: 'live_batch' }),
  'live.reply_then_private': Object.freeze({ version: '1', required: ['url'], kind: 'live_reply_then_private' }),
  'comment.reply_then_private': Object.freeze({ version: '1', required: ['url'], kind: 'comment_reply_then_private' }),
  'video.search': Object.freeze({ version: '1', required: ['keyword'], kind: 'video_search' })
});

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requestForWorkflow(value) {
  if (!isPlainObject(value)) throw new TypeError('workflow request must be an object');
  const workflowId = String(value.workflowId || '').trim();
  const spec = WORKFLOW_IDS[workflowId];
  if (!spec) throw new TypeError('unsupported workflowId: ' + (workflowId || '(empty)'));
  const version = String(value.version == null ? spec.version : value.version).trim();
  if (version !== spec.version) throw new TypeError('unsupported ' + workflowId + ' version: ' + version);
  const params = isPlainObject(value.params) ? value.params : {};
  for (const key of spec.required) {
    const item = params[key];
    const ok = key === 'keywords'
      ? Array.isArray(item) && item.some((entry) => typeof entry === 'string' && entry.trim())
      : typeof item === 'string' && item.trim().length > 0;
    if (!ok) throw new TypeError('workflow request is missing ' + key);
  }
  return { workflowId, version, params: { ...params } };
}

// 给平台规划器的一句人话 + 结构化上下文。上下文是给规划器看的，不是计划本身。
function buildWorkflowIntent(request) {
  const spec = requestForWorkflow(request);
  const params = spec.params;
  if (spec.workflowId === 'live.batch') {
    const keywords = (params.keywords || []).join('、');
    const window = Number.isInteger(params.windowSeconds) ? params.windowSeconds : 300;
    const via = params.replyVia === 'mention_text' ? '公屏纯文本 @' : '原生「回复 TA」';
    return '在直播间 ' + params.url + ' 监听弹幕，命中关键词「' + keywords + '」的观众：先用' + via
      + '在公屏回复，确认成功后再发私信。批次窗口 ' + window + ' 秒，最多回复 '
      + (Number.isInteger(params.maxSends) ? params.maxSends : 10) + ' 条。';
  }
  if (spec.workflowId === 'video.search') return '搜索视频：' + params.keyword;
  return '在 ' + params.url + ' 按关键词处理公开评论并在确认成功后发送私信。';
}

function buildWorkflowContext(request) {
  const spec = requestForWorkflow(request);
  return { requestedBy: 'task_panel', workflowId: spec.workflowId, version: spec.version, params: spec.params };
}

function sameParams(actual, expected) {
  if (!isPlainObject(actual)) return false;
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    const left = actual[key];
    const right = expected[key];
    if (Array.isArray(right) || Array.isArray(left)) {
      const a = Array.isArray(left) ? left : [];
      const b = Array.isArray(right) ? right : [];
      if (a.length !== b.length || a.some((entry, index) => entry !== b[index])) return false;
      continue;
    }
    if (left !== right) return false;
  }
  return true;
}

// 平台返回的计划必须与结构化请求一致，否则拒绝启动（fail-closed）。
function planMatchesRequest(plan, request) {
  const spec = requestForWorkflow(request);
  if (!isPlainObject(plan)) return { ok: false, reason: 'plan_missing' };
  if (String(plan.workflowId || '') !== spec.workflowId) return { ok: false, reason: 'workflow_mismatch' };
  if (String(plan.version || '') !== spec.version) return { ok: false, reason: 'version_mismatch' };
  if (typeof plan.planId !== 'string' || !plan.planId.trim()) return { ok: false, reason: 'plan_id_missing' };
  const planned = isPlainObject(plan.params) ? plan.params : {};
  // 只核对本次请求里【明确要求】的字段：平台可以补充自己的字段（例如策略、知识集），
  // 但不能改动我们要发什么、发给谁、什么时候发。
  for (const [key, value] of Object.entries(spec.params)) {
    if (!sameParams({ [key]: planned[key] }, { [key]: value })) {
      return { ok: false, reason: 'param_mismatch', field: key };
    }
  }
  return { ok: true };
}

module.exports = { WORKFLOW_IDS, requestForWorkflow, buildWorkflowIntent, buildWorkflowContext, planMatchesRequest };
