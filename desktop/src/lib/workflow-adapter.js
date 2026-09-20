'use strict';

// Platform-owned bridge between the versioned workflow runtime and a browser
// adapter.  The collaborator owns the sidecar methods; this module owns the
// workflow boundary, target freezing and fail-closed result mapping.

// The canonical workflow contract accepts exactly this server/platform
// delivery result. DOM clicks, HTTP 200, and generic "success" labels are not
// proof that the platform delivered a message.
const CONFIRMED = new Set(['sent_confirmed']);
const HUMAN_REQUIRED = new Set(['blocked', 'captcha', 'login_required', 'unsupported']);

function requiredObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function optionalText(value, max = 1000) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > max) throw new TypeError('workflow text parameter is invalid');
  return value.trim();
}

function resultText(value, max = 1000) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

function resultInteger(value, min = 0, max = 1000000) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function resultIdList(value, max = 20000) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].slice(0, max);
}

function searchVideos(value) {
  return (Array.isArray(value) ? value : []).slice(0, 100).map((video) => ({
    id: optionalText(video?.id || video?.awemeId, 240),
    url: optionalText(video?.url, 2048),
    title: optionalText(video?.title || video?.desc, 500),
    author: optionalText(video?.author, 200),
    relevance: video?.relevance?.score ?? video?.relevanceScore ?? null
  }));
}

function searchEnvelope(result) {
  const envelope = {
    kind: 'video_search',
    videos: searchVideos(result?.videos),
    cursor: result?.cursor || null,
    hasMore: result?.hasMore === true
  };
  const poolIds = resultIdList(result?.poolIds);
  if (poolIds) envelope.poolIds = poolIds;
  for (const key of ['poolSize', 'page', 'skippedSeen']) {
    const value = resultInteger(result?.[key]);
    if (value != null) envelope[key] = value;
  }
  const stoppedReason = resultText(result?.stoppedReason, 120);
  if (stoppedReason) envelope.stoppedReason = stoppedReason;
  if (typeof result?.platformHasMore === 'boolean') envelope.platformHasMore = result.platformHasMore;
  else if (result?.platformHasMore === 0 || result?.platformHasMore === 1) envelope.platformHasMore = result.platformHasMore === 1;
  const platformCursor = resultText(result?.platformCursor, 500);
  if (platformCursor) envelope.platformCursor = platformCursor;
  if (result?.filter && typeof result.filter === 'object' && !Array.isArray(result.filter)) {
    const filter = {};
    for (const key of ['collected', 'returned', 'filteredByRelevance', 'minRelevance', 'kept', 'poolAdded']) {
      const value = resultInteger(result.filter[key], 0, 1000000);
      if (value != null) filter[key] = value;
    }
    if (Object.keys(filter).length) envelope.filter = filter;
  }
  return envelope;
}

function searchCheckpoint(envelope, status) {
  const checkpoint = {
    phase: 'search',
    status,
    count: envelope.videos.length,
    cursor: envelope.cursor,
    hasMore: envelope.hasMore
  };
  for (const key of ['stoppedReason', 'poolIds', 'poolSize', 'page', 'skippedSeen', 'platformHasMore', 'platformCursor', 'filter']) {
    if (envelope[key] !== undefined) checkpoint[key] = envelope[key];
  }
  return checkpoint;
}

function sourceForWorkflow(workflowId) {
  if (workflowId === 'comment.reply_then_private') return 'video';
  if (workflowId === 'live.reply_then_private') return 'live';
  return null;
}

function outcomeFromSend(result, { phase, target }) {
  const status = String(result?.status || 'unknown');
  const detail = {
    phase,
    target: target ? { id: target.id || '', roomId: target.roomId || '', authorId: target.authorId || '', authorName: target.authorName || '' } : null,
    result: { status, reason: result?.reason || null, sendId: result?.sendId || null }
  };
  const resultEnvelope = { deliveryStatus: status, reason: result?.reason || null, sendId: result?.sendId || null };
  if (CONFIRMED.has(status)) return { status: 'completed', result: resultEnvelope, checkpoint: detail };
  if (status === 'unknown' || status === 'sent_unknown' || status === 'started') return { status: 'unknown', result: resultEnvelope, checkpoint: detail, error: { code: 'SIDE_EFFECT_RESULT_UNKNOWN', message: `${phase} 结果未被平台确认` } };
  if (HUMAN_REQUIRED.has(status)) return { status: 'wait_human', result: resultEnvelope, checkpoint: { ...detail, reason: result?.reason || status }, error: { code: 'HUMAN_ACTION_REQUIRED', message: `${phase} 需要人工处理` } };
  if (status === 'failed') return { status: 'failed', result: resultEnvelope, checkpoint: detail, error: { code: 'PLATFORM_ACTION_FAILED', message: result?.reason || `${phase} 执行失败` } };
  return { status: 'wait_human', result: resultEnvelope, checkpoint: { ...detail, reason: 'unrecognized_send_status' }, error: { code: 'UNRECOGNIZED_SEND_STATUS', message: `${phase} 返回了未识别状态` } };
}

function safeTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    id: optionalText(value.id, 240),
    roomId: optionalText(value.roomId, 2048),
    authorId: optionalText(value.authorId, 240),
    authorName: optionalText(value.authorName, 120),
    text: optionalText(value.text, 1000),
    fingerprint: optionalText(value.fingerprint, 500)
  };
}

function matchEvent(event, params) {
  const text = String(event?.text || '').toLocaleLowerCase();
  const keywords = Array.isArray(params.keywords) ? params.keywords.map((x) => optionalText(x, 200).toLocaleLowerCase()).filter(Boolean) : [];
  const excludes = Array.isArray(params.excludeKeywords) ? params.excludeKeywords.map((x) => optionalText(x, 200).toLocaleLowerCase()).filter(Boolean) : [];
  if (excludes.some((x) => text.includes(x))) return false;
  return !keywords.length || keywords.some((x) => text.includes(x));
}

function createWorkflowAdapter({ browser, state = new Map() } = {}) {
  if (!browser || typeof browser !== 'object') throw new TypeError('workflow adapter browser is required');

  async function collectTarget(run, plan, source) {
    const params = requiredObject(plan.params || {}, 'workflow params');
    const existing = safeTarget(params.target || params.event || state.get(run.runId)?.target || run.checkpoint?.target);
    if (existing) return existing;
    if (typeof browser.collectOnce !== 'function') return null;
    const url = optionalText(params.url, 2048);
    if (!url) return null;
    if (typeof browser.isOpenFor === 'function' && !browser.isOpenFor(url) && typeof browser.open === 'function') await browser.open(url);
    const collected = await browser.collectOnce(source, url, {
      maxItems: Number.isInteger(params.maxItems) ? params.maxItems : 100,
      scrollRounds: Number.isInteger(params.scrollRounds) ? params.scrollRounds : 0
    });
    const events = Array.isArray(collected?.events) ? collected.events : [];
    const target = safeTarget(events.find((event) => matchEvent(event, params)));
    if (target) state.set(run.runId, { target });
    return target;
  }

  async function execute({ run, plan, step, action }) {
    const workflowId = run.workflowId;
    if (workflowId === 'video.search' && step.stepId === 'search') {
      const params = requiredObject(plan.params || {}, 'workflow params');
      if (typeof browser.search !== 'function') return { status: 'failed', error: { code: 'SEARCH_ADAPTER_UNAVAILABLE', message: '视频搜索适配器不可用' } };
      const keyword = optionalText(params.keyword, 200);
      if (!keyword) return { status: 'failed', error: { code: 'SEARCH_KEYWORD_MISSING', message: '视频搜索缺少关键词' } };
      const result = await browser.search({
        keyword,
        maxVideos: Number.isInteger(params.maxVideos) ? params.maxVideos : 20,
        scrollRounds: Number.isInteger(params.scrollRounds) ? params.scrollRounds : 2,
        cursor: params.cursor == null ? undefined : optionalText(params.cursor, 500),
        page: Number.isInteger(params.page) ? params.page : undefined,
        minRelevance: Number.isInteger(params.minRelevance) ? params.minRelevance : undefined,
        strict: params.strict === true
      });
      const status = String(result?.status || 'unknown');
      const envelope = searchEnvelope(result);
      if (status === 'captcha' || status === 'login_required' || status === 'unsupported') return { status: 'wait_human', result: envelope, checkpoint: searchCheckpoint(envelope, status), error: { code: 'SEARCH_REQUIRES_HUMAN', message: '搜索需要人工处理后继续' } };
      if (status !== 'ok') return { status: 'unknown', checkpoint: { phase: 'search', status }, error: { code: 'SEARCH_RESULT_UNKNOWN', message: '搜索结果未确认' } };
      return { status: 'completed', result: envelope, checkpoint: searchCheckpoint(envelope, status) };
    }

    const source = sourceForWorkflow(workflowId);
    if (!source || !['reply_comment', 'reply_public', 'private_message'].includes(step.stepId)) return { status: 'failed', error: { code: 'WORKFLOW_STEP_UNSUPPORTED', message: `未接入固定步骤 ${workflowId}/${step.stepId}` } };
    const params = requiredObject(plan.params || {}, 'workflow params');
    const keywords = Array.isArray(params.keywords) ? params.keywords.map((item) => optionalText(item, 200)).filter(Boolean) : [];
    if (!keywords.length) return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'keywords_missing' }, error: { code: 'WORKFLOW_KEYWORDS_MISSING', message: '评论/直播流程必须先冻结至少一个关键词' } };
    const saved = state.get(run.runId) || {};
    const target = safeTarget(params.target || params.event || saved.target || run.checkpoint?.target);
    const resolvedTarget = target || await collectTarget(run, plan, source);
    if (!resolvedTarget) return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'target_not_found_or_collector_unavailable' }, error: { code: 'TARGET_REQUIRES_HUMAN', message: '没有可安全确认的目标评论' } };
    // A caller supplied target is still subject to the frozen workflow rule.
    // Do not let an unfiltered event bypass keyword/exclude matching simply
    // because it already contains an id and room URL.
    if (!matchEvent(resolvedTarget, params)) return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'target_does_not_match_keywords' }, error: { code: 'TARGET_KEYWORD_MISMATCH', message: '目标评论未通过关键词筛选' } };
    if (!resolvedTarget.roomId) return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'target_room_missing' }, error: { code: 'TARGET_ROOM_MISSING', message: '目标页面身份缺失' } };
    const reply = step.stepId === 'private_message'
      ? optionalText(params.privateReply || params.privateText || params.replyPlan?.privateReply, 1000)
      : optionalText(params.publicReply || params.reply || params.text || params.replyPlan?.publicReply, 1000);
    if (!reply) return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'reply_text_missing' }, error: { code: 'REPLY_TEXT_MISSING', message: '固定流程没有冻结话术' } };
    if (step.stepId === 'private_message' && !resolvedTarget.authorId) return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'private_author_missing' }, error: { code: 'PRIVATE_TARGET_ID_MISSING', message: '私信目标缺少平台身份' } };
    const channel = step.stepId === 'private_message' ? 'private' : source;
    if (typeof browser.canSend !== 'function' || browser.canSend(channel) !== true) return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'adapter_not_auto_eligible' }, error: { code: 'ADAPTER_NOT_AUTO_ELIGIBLE', message: '当前适配器没有自动发送资格，已转人工' } };
    if (typeof browser.isOpenFor === 'function' && !browser.isOpenFor(resolvedTarget.roomId) && typeof browser.open === 'function') await browser.open(resolvedTarget.roomId);
    const actionState = state.get(run.runId) || {};
    const sendId = actionState[step.stepId === 'private_message' ? 'privateSendId' : 'publicSendId'] || action?.idempotencyKey || action?.actionId;
    if (!sendId) return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'send_id_missing' }, error: { code: 'SEND_ID_MISSING', message: '副作用动作缺少幂等发送 ID' } };
    if (step.stepId === 'private_message' && typeof browser.sendPrivate !== 'function') return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'private_adapter_unavailable' }, error: { code: 'PRIVATE_ADAPTER_UNAVAILABLE', message: '私信适配器不可用，已转人工' } };
    if (step.stepId !== 'private_message' && typeof browser.sendReply !== 'function') return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'public_adapter_unavailable' }, error: { code: 'PUBLIC_ADAPTER_UNAVAILABLE', message: '公屏回复适配器不可用，已转人工' } };
    const result = step.stepId === 'private_message'
      ? await browser.sendPrivate(reply, { ...resolvedTarget, sendId })
      : await browser.sendReply(reply, source, { ...resolvedTarget, sendId });
    const current = state.get(run.runId) || {};
    state.set(run.runId, { ...current, target: resolvedTarget, [step.stepId === 'private_message' ? 'privateSendId' : 'publicSendId']: sendId, [step.stepId === 'private_message' ? 'privateResult' : 'publicResult']: { status: result?.status || 'unknown', reason: result?.reason || null } });
    return outcomeFromSend(result, { phase: step.stepId, target: resolvedTarget });
  }

  async function reconcile() {
    return { status: 'wait_human', checkpoint: { reason: 'platform_send_status_not_queryable' } };
  }

  return { execute, reconcile, state };
}

module.exports = { createWorkflowAdapter, CONFIRMED };
