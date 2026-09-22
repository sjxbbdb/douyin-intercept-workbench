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
  const cursorVersion = resultInteger(result?.cursorVersion, 0, 1000);
  if (cursorVersion != null) envelope.cursorVersion = cursorVersion;
  const pageOutcome = resultText(result?.pageOutcome, 40);
  if (new Set(['more', 'exhausted', 'captcha', 'login_required']).has(pageOutcome)) envelope.pageOutcome = pageOutcome;
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
  for (const key of ['stoppedReason', 'poolIds', 'poolSize', 'page', 'skippedSeen', 'platformHasMore', 'platformCursor', 'cursorVersion', 'pageOutcome', 'filter']) {
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


// ---------------------------------------------------------------------------
// 直播间【批次】工作流（live.batch）：
//   固定工作流显式调用侧车的五个 live_* 方法，而不是走通用单发适配器。
//   为什么需要它：关键词过滤、时间窗、去重、过期处理、原生「回复 TA」、私密账号跳过
//   这些都发生在【批次】语义里，通用单发（collectOnce/sendReply/sendPrivate）表达不了；
//   公屏与私信的结果也要落在同一份台账上，才能被平台运行时（检查点 + 台账）消费。
// ---------------------------------------------------------------------------

const LIVE_BATCH_STEPS = new Set(['listen', 'plan', 'reply_public', 'private_message', 'report']);
const MATCH_MODES = new Set(['phrase', 'seg', 'all', 'any']);
const QUEUE_KEYS = ['added', 'duplicates', 'capacity', 'expired', 'queued', 'total', 'status'];

function boundedInteger(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function queueSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of QUEUE_KEYS) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) out[key] = value[key];
  }
  return Object.keys(out).length ? out : null;
}

function liveEvents(value) {
  return (Array.isArray(value) ? value : []).slice(0, 500).map((event) => ({
    eventId: optionalText(event?.id || event?.eventId, 240),
    authorId: optionalText(event?.authorId, 240),
    authorName: optionalText(event?.authorName, 120),
    text: optionalText(event?.text, 500),
    dmCapable: event?.dmCapable === true
  })).filter((event) => event.eventId);
}

function ledgerFor(state, runId) {
  const current = state.get(runId) || {};
  if (!current.liveLedger) {
    current.liveLedger = { batchId: null, targets: [], listen: [], entries: new Map(), skipped: [] };
    state.set(runId, current);
  }
  return current.liveLedger;
}

function commentLedgerFor(state, runId) {
  const current = state.get(runId) || {};
  if (!current.commentLedger) {
    current.commentLedger = { batchId: null, targets: [], entries: new Map(), skipped: [] };
    state.set(runId, current);
  }
  return current.commentLedger;
}

function ledgerEntry(ledger, eventId) {
  if (!ledger.entries.has(eventId)) ledger.entries.set(eventId, { eventId, public: null, private: null });
  return ledger.entries.get(eventId);
}

function ledgerSnapshot(ledger) {
  return [...ledger.entries.values()].map((entry) => ({
    eventId: entry.eventId,
    public: entry.public ? { ...entry.public } : null,
    private: entry.private ? { ...entry.private } : null
  }));
}

function ledgerCounts(ledger) {
  // privateSkipped 只从台账条目上数，避免和 ledger.skipped 列表重复计数。
  const counts = { events: ledger.entries.size, publicConfirmed: 0, publicUnknown: 0, publicFailed: 0,
    privateSent: 0, privateUnknown: 0, privateSkipped: 0, privateBlocked: 0 };
  for (const entry of ledger.entries.values()) {
    if (entry.public) {
      if (entry.public.status === 'sent_confirmed') counts.publicConfirmed += 1;
      else if (entry.public.status === 'failed' || entry.public.status === 'blocked') counts.publicFailed += 1;
      else counts.publicUnknown += 1;
    }
    if (entry.private) {
      if (entry.private.skipped === true) counts.privateSkipped += 1;
      else if (entry.private.status === 'sent_confirmed') counts.privateSent += 1;
      else if (entry.private.status === 'failed' || entry.private.status === 'blocked') counts.privateBlocked += 1;
      else counts.privateUnknown += 1;
    }
  }
  return counts;
}

function scriptsForPlan(params, listenEventsList) {
  const provided = params.scripts;
  if (provided && typeof provided === 'object' && !Array.isArray(provided)) {
    const out = {};
    for (const [eventId, script] of Object.entries(provided).slice(0, 200)) {
      if (!script || typeof script !== 'object' || Array.isArray(script)) continue;
      const publicText = optionalText(script.publicText ?? script.public, 500);
      const privateText = optionalText(script.privateText ?? script.private, 500);
      const key = optionalText(eventId, 240);
      if (key) out[key] = { publicText, privateText };
    }
    if (Object.keys(out).length) return out;
  }
  // 没有逐条话术时，退化成"同一套话术套用到本轮监听到的每条弹幕"。
  // 话术仍然由平台侧提供：这里不代写、不改写。
  const template = {
    publicText: optionalText(params.publicReply || params.reply || params.text || params.replyPlan?.publicReply, 500),
    privateText: optionalText(params.privateReply || params.replyPlan?.privateReply, 500)
  };
  if (!template.publicText || !template.privateText) return null;
  const out = {};
  for (const event of Array.isArray(listenEventsList) ? listenEventsList : []) {
    out[event.eventId] = { ...template };
  }
  return Object.keys(out).length ? out : null;
}

function resultSummary(results) {
  const summary = { attempted: results.length, confirmed: 0, unknown: 0, failed: 0, blocked: 0 };
  for (const item of results) {
    const status = String(item?.status || 'unknown');
    if (status === 'sent_confirmed') summary.confirmed += 1;
    else if (status === 'failed') summary.failed += 1;
    else if (status === 'blocked') summary.blocked += 1;
    else summary.unknown += 1;
  }
  return summary;
}

function aggregateSendStatus(summary, phase) {
  if (summary.attempted > 0 && summary.confirmed === summary.attempted) {
    return { status: 'completed', deliveryStatus: 'sent_confirmed', code: null };
  }
  if (summary.failed > 0 || summary.blocked > 0) {
    return { status: 'wait_human', deliveryStatus: 'blocked', code: phase === 'private' ? 'LIVE_PRIVATE_BLOCKED' : 'LIVE_PUBLIC_BLOCKED' };
  }
  return { status: 'unknown', deliveryStatus: 'unknown', code: 'SIDE_EFFECT_RESULT_UNKNOWN' };
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

    if (workflowId === 'comment.batch') {
      const params = requiredObject(plan.params || {}, 'workflow params');
      const ledger = commentLedgerFor(state, run.runId);
      const baseSendId = optionalText(action?.idempotencyKey || action?.actionId, 300);
      const targetRows = (value) => (Array.isArray(value) ? value : []).slice(0, 200).map((target) => ({
        eventId: optionalText(target?.eventId || target?.id, 240),
        authorId: optionalText(target?.authorId, 240),
        authorName: optionalText(target?.authorName, 120),
        roomId: optionalText(target?.roomId, 2048),
        text: optionalText(target?.text, 500),
        publicText: optionalText(target?.publicText, 1000),
        privateText: optionalText(target?.privateText, 1000)
      })).filter((target) => target.eventId);

      if (step.stepId === 'plan') {
        if (typeof browser.commentPlan !== 'function') return { status: 'failed', error: { code: 'COMMENT_PLAN_ADAPTER_UNAVAILABLE', message: '侧车未提供 comment_plan' } };
        const commentKeywords = (Array.isArray(params.commentKeywords) ? params.commentKeywords : Array.isArray(params.keywords) ? params.keywords : []).map((item) => optionalText(item, 200)).filter(Boolean);
        if (!commentKeywords.length) return { status: 'wait_human', checkpoint: { phase: 'plan', reason: 'comment_keywords_missing' }, error: { code: 'COMMENT_KEYWORDS_MISSING', message: '评论批次必须先冻结至少一个关键词' } };
        const publicText = optionalText(params.publicText || params.publicReply || params.reply || params.text, 1000);
        const privateText = optionalText(params.privateText || params.privateReply, 1000);
        if (!publicText || !privateText) return { status: 'wait_human', checkpoint: { phase: 'plan', reason: 'scripts_missing' }, error: { code: 'COMMENT_SCRIPTS_MISSING', message: '评论批次缺少平台侧下发的话术' } };
        const request = {
          maxItems: boundedInteger(params.maxItems, 1, 50, 20),
          windowSeconds: boundedInteger(params.windowSeconds, 1, 86_400, 3600),
          scrollRounds: boundedInteger(params.scrollRounds, 0, 40, 6),
          collectMaxItems: boundedInteger(params.collectMaxItems, 1, 500, 200),
          minDigg: boundedInteger(params.minDigg, 0, 1_000_000, 0),
          commentKeywords,
          excludeKeywords: (Array.isArray(params.excludeKeywords) ? params.excludeKeywords : []).map((item) => optionalText(item, 200)).filter(Boolean),
          matchMode: MATCH_MODES.has(params.matchMode) ? params.matchMode : 'seg',
          dedupeAuthors: params.dedupeAuthors !== false,
          publicText,
          privateText
        };
        const videoId = optionalText(params.videoId, 240);
        const url = optionalText(params.url, 2048);
        if (videoId) request.videoId = videoId; else if (url) request.url = url;
        else return { status: 'wait_human', checkpoint: { phase: 'plan', reason: 'video_reference_missing' }, error: { code: 'COMMENT_VIDEO_REFERENCE_MISSING', message: '评论批次缺少视频 URL 或 videoId' } };
        const result = await browser.commentPlan(request);
        const status = String(result?.status || 'unknown');
        const batchId = optionalText(result?.batch?.batchId, 300);
        const targets = targetRows(result?.targets);
        const blockedReasons = (Array.isArray(result?.blocked) ? result.blocked : []).slice(0, 200).map((item) => ({ eventId: optionalText(item?.eventId, 240), reason: optionalText(item?.reason, 120) }));
        const checkpoint = {
          phase: 'plan', status, batchId, targets: targets.length,
          blocked: blockedReasons.length, blockedReasons, expired: Array.isArray(result?.expired) ? result.expired.length : 0,
          filter: result?.filter || null, batchFilter: result?.batchFilter || null
        };
        if (['login_required', 'captcha', 'unsupported'].includes(status)) return { status: 'wait_human', result: { kind: 'comment_plan', status, batchId: batchId || null, filter: result?.filter || null }, checkpoint: { ...checkpoint, reason: status }, error: { code: 'COMMENT_REQUIRES_HUMAN', message: '评论采集需要人工处理（登录 / 验证码 / 页面不可用）' } };
        if (status === 'empty' || !targets.length || !batchId) return { status: 'wait_human', result: { kind: 'comment_plan', status, batchId: batchId || null, filter: result?.filter || null }, checkpoint: { ...checkpoint, reason: status === 'empty' ? 'no_matching_comments' : 'plan_not_frozen' }, error: { code: 'COMMENT_BATCH_NOT_PLANNED', message: '没有命中关键词的评论或批次未冻结' } };
        ledger.batchId = batchId;
        ledger.targets = targets;
        return { status: 'completed', result: { kind: 'comment_plan', status, batchId, targets: targets.length, blocked: blockedReasons.length, filter: result?.filter || null }, checkpoint };
      }

      if (step.stepId === 'reply_public' || step.stepId === 'private_message') {
        const isPrivate = step.stepId === 'private_message';
        const method = isPrivate ? browser.commentPrivate : browser.commentReply;
        if (typeof method !== 'function') return { status: 'failed', error: { code: isPrivate ? 'COMMENT_PRIVATE_ADAPTER_UNAVAILABLE' : 'COMMENT_REPLY_ADAPTER_UNAVAILABLE', message: isPrivate ? '侧车未提供 comment_private' : '侧车未提供 comment_reply' } };
        if (!ledger.batchId) return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'batch_not_planned' }, error: { code: 'COMMENT_BATCH_NOT_PLANNED', message: '没有已冻结的评论批次，禁止发送' } };
        if (!baseSendId) return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'send_id_missing' }, error: { code: 'SEND_ID_MISSING', message: '评论批次副作用动作缺少幂等发送 ID' } };
        const limit = boundedInteger(params.maxSends, 1, 50, 10);
        let items;
        if (isPrivate) {
          items = ledgerSnapshot(ledger).filter((entry) => entry.public?.status === 'sent_confirmed' && entry.public.sendId).slice(0, limit).map((entry) => {
            const target = ledger.targets.find((item) => item.eventId === entry.eventId);
            return { eventId: entry.eventId, sendId: `${baseSendId}~private~${entry.eventId}`, publicSendId: entry.public.sendId, text: target?.privateText || '' };
          });
          for (const target of ledger.targets) {
            const entry = ledgerEntry(ledger, target.eventId);
            if (!entry.private && (!entry.public || entry.public.status !== 'sent_confirmed')) entry.private = { status: 'blocked', reason: 'public_delivery_not_confirmed', sendId: null, recordedState: null, skipped: true };
          }
          if (!items.length) return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'no_confirmed_public_delivery' }, error: { code: 'PUBLIC_DELIVERY_NOT_CONFIRMED', message: '没有公屏确认成功的评论目标，禁止私信' } };
        } else {
          items = ledger.targets.slice(0, limit).map((target) => ({ eventId: target.eventId, sendId: `${baseSendId}~public~${target.eventId}`, text: target.publicText || '' }));
          if (!items.length) return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'no_targets' }, error: { code: 'COMMENT_BATCH_NO_TARGETS', message: '批次里没有可回复的评论目标' } };
        }
        const result = await method({ batchId: ledger.batchId, items });
        const results = Array.isArray(result?.results) ? result.results : [];
        for (const item of results) {
          const eventId = optionalText(item?.eventId, 240);
          if (!eventId) continue;
          const entry = ledgerEntry(ledger, eventId);
          const record = { status: String(item?.status || 'unknown'), reason: resultText(item?.reason, 200), sendId: optionalText(item?.sendId, 300), recordedState: resultText(item?.recordedState, 60), skipped: item?.evidence?.skipped === true };
          if (isPrivate) entry.private = record; else entry.public = record;
        }
        const summary = resultSummary(items.map((item) => results.find((row) => row?.eventId === item.eventId)));
        const aggregate = aggregateSendStatus(summary, isPrivate ? 'private' : 'public');
        const checkpoint = { phase: step.stepId, batchId: ledger.batchId, attempted: summary.attempted, confirmed: summary.confirmed, unknown: summary.unknown, failed: summary.failed, blocked: summary.blocked, reason: resultText(result?.reason, 200) };
        const envelope = { deliveryStatus: aggregate.deliveryStatus, kind: isPrivate ? 'comment_private' : 'comment_reply', batchId: ledger.batchId, summary, ledger: ledgerSnapshot(ledger), counts: ledgerCounts(ledger) };
        if (aggregate.status === 'completed') return { status: 'completed', result: envelope, checkpoint };
        if (aggregate.status === 'wait_human') return { status: 'wait_human', result: envelope, checkpoint: { ...checkpoint, reason: checkpoint.reason || 'platform_blocked' }, error: { code: isPrivate ? 'COMMENT_PRIVATE_BLOCKED' : 'COMMENT_PUBLIC_BLOCKED', message: isPrivate ? '评论私信被平台拦下，需要人工处理' : '评论公屏回复被平台拦下，需要人工处理' } };
        return { status: 'unknown', result: envelope, checkpoint, error: { code: 'SIDE_EFFECT_RESULT_UNKNOWN', message: isPrivate ? '评论私信结果未被平台确认' : '评论公屏结果未被平台确认' } };
      }

      if (step.stepId === 'report') {
        if (typeof browser.commentResult !== 'function') return { status: 'failed', error: { code: 'COMMENT_RESULT_ADAPTER_UNAVAILABLE', message: '侧车未提供 comment_result' } };
        const result = ledger.batchId ? await browser.commentResult({ batchId: ledger.batchId }) : null;
        const counts = ledgerCounts(ledger);
        const checkpoint = { phase: 'report', batchId: ledger.batchId, counts, platformCheckpoint: result?.checkpoint || null };
        return { status: 'completed', result: { kind: 'comment_batch_ledger', batchId: ledger.batchId, ledger: ledgerSnapshot(ledger), counts }, checkpoint };
      }
      return { status: 'failed', error: { code: 'WORKFLOW_STEP_UNSUPPORTED', message: `未接入固定步骤 comment.batch/${step.stepId}` } };
    }

    if (run.workflowId === 'live.batch') {
      const params = requiredObject(plan.params || {}, 'workflow params');
      const ledger = ledgerFor(state, run.runId);
      const baseSendId = optionalText(action?.idempotencyKey || action?.actionId, 300);

      if (step.stepId === 'listen') {
        if (typeof browser.liveListen !== 'function') return { status: 'failed', error: { code: 'LIVE_LISTEN_ADAPTER_UNAVAILABLE', message: '侧车未提供 live_listen' } };
        const url = optionalText(params.url, 2048);
        if (!url) return { status: 'wait_human', checkpoint: { phase: 'listen', reason: 'live_url_missing' }, error: { code: 'LIVE_URL_MISSING', message: '直播批次缺少直播间地址' } };
        const result = await browser.liveListen({ url, maxItems: boundedInteger(params.maxItems, 1, 500, 100) });
        const status = String(result?.status || 'unknown');
        const events = liveEvents(result?.events);
        const checkpoint = { phase: 'listen', status, count: events.length, queue: queueSnapshot(result?.queue) };
        if (status === 'login_required' || status === 'captcha' || status === 'unsupported') {
          return { status: 'wait_human', result: { kind: 'live_listen', status, events: [] }, checkpoint: { ...checkpoint, reason: status }, error: { code: 'LIVE_REQUIRES_HUMAN', message: '直播监听需要人工处理（登录 / 验证码）' } };
        }
        if (status !== 'ok') return { status: 'unknown', result: { kind: 'live_listen', status, events }, checkpoint, error: { code: 'LIVE_LISTEN_RESULT_UNKNOWN', message: '直播监听结果未被确认' } };
        if (!events.length) return { status: 'wait_human', result: { kind: 'live_listen', status, events }, checkpoint: { ...checkpoint, reason: 'no_events' }, error: { code: 'LIVE_EVENTS_EMPTY', message: '这一轮没有采集到弹幕' } };
        ledger.listen = events;
        return { status: 'completed', result: { kind: 'live_listen', status, events, queue: queueSnapshot(result?.queue) }, checkpoint };
      }

      if (step.stepId === 'plan') {
        if (typeof browser.livePlan !== 'function') return { status: 'failed', error: { code: 'LIVE_PLAN_ADAPTER_UNAVAILABLE', message: '侧车未提供 live_plan' } };
        const keywords = (Array.isArray(params.keywords) ? params.keywords : []).map((item) => optionalText(item, 200)).filter(Boolean);
        if (!keywords.length) return { status: 'wait_human', checkpoint: { phase: 'plan', reason: 'keywords_missing' }, error: { code: 'WORKFLOW_KEYWORDS_MISSING', message: '直播批次必须先冻结至少一个关键词' } };
        const excludeKeywords = (Array.isArray(params.excludeKeywords) ? params.excludeKeywords : []).map((item) => optionalText(item, 200)).filter(Boolean);
        const scripts = scriptsForPlan(params, ledger.listen);
        if (!scripts) return { status: 'wait_human', checkpoint: { phase: 'plan', reason: 'scripts_missing' }, error: { code: 'LIVE_SCRIPTS_MISSING', message: '直播批次缺少平台侧下发的话术' } };
        const result = await browser.livePlan({
          maxItems: boundedInteger(params.maxItems, 1, 200, 20),
          windowSeconds: boundedInteger(params.windowSeconds, 1, 86_400, 300),
          keywords,
          excludeKeywords,
          matchMode: MATCH_MODES.has(params.matchMode) ? params.matchMode : 'seg',
          replyMode: params.replyMode === 'danmaku' ? 'danmaku' : 'composer',
          replyVia: params.replyVia === 'mention_text' ? 'mention_text' : 'native',
          scripts
        });
        const status = String(result?.status || 'unknown');
        const batchId = optionalText(result?.batch?.batchId, 300);
        const targets = (Array.isArray(result?.targets) ? result.targets : []).slice(0, 200).map((target) => ({
          eventId: optionalText(target?.eventId, 240),
          authorId: optionalText(target?.authorId, 240),
          authorName: optionalText(target?.authorName, 120),
          roomId: optionalText(target?.roomId, 2048),
          text: optionalText(target?.text, 500),
          publicText: optionalText(target?.publicText, 500),
          privateText: optionalText(target?.privateText, 500)
        })).filter((target) => target.eventId);
        const blockedReasons = (Array.isArray(result?.blocked) ? result.blocked : []).slice(0, 200).map((item) => ({
          eventId: optionalText(item?.eventId, 240),
          reason: optionalText(item?.reason, 120)
        }));
        const checkpoint = {
          phase: 'plan', status, batchId, targets: targets.length,
          blocked: blockedReasons.length, blockedReasons, expired: result?.expired?.length ?? result?.batch?.expiredCount ?? 0,
          filter: result?.filter || result?.batch?.filter || null,
          replyMode: result?.replyMode || (params.replyMode === 'danmaku' ? 'danmaku' : 'composer'),
          replyVia: result?.replyVia || (params.replyVia === 'mention_text' ? 'mention_text' : 'native')
        };
        if (status === 'empty') return { status: 'wait_human', result: { kind: 'live_plan', status, batchId: batchId || null }, checkpoint: { ...checkpoint, reason: 'no_events_in_window' }, error: { code: 'LIVE_BATCH_EMPTY', message: '批次窗口内没有命中关键词的弹幕' } };
        if (status === 'blocked' || !targets.length || !batchId) {
          return { status: 'wait_human', result: { kind: 'live_plan', status, batchId: batchId || null, blocked: blockedReasons }, checkpoint: { ...checkpoint, reason: status === 'blocked' ? 'targets_blocked' : 'plan_not_frozen' }, error: { code: 'LIVE_BATCH_NOT_PLANNED', message: '批次没有可执行的目标（话术或昵称缺失）' } };
        }
        ledger.batchId = batchId;
        ledger.targets = targets;
        ledger.replyMode = checkpoint.replyMode;
        ledger.replyVia = checkpoint.replyVia;
        return { status: 'completed', result: { kind: 'live_plan', status, batchId, targets: targets.length, blocked: blockedReasons.length, replyMode: checkpoint.replyMode, replyVia: checkpoint.replyVia }, checkpoint };
      }

      if (step.stepId === 'reply_public' || step.stepId === 'private_message') {
        const isPrivate = step.stepId === 'private_message';
        const method = isPrivate ? browser.livePrivate : browser.liveReply;
        if (typeof method !== 'function') return { status: 'failed', error: { code: isPrivate ? 'LIVE_PRIVATE_ADAPTER_UNAVAILABLE' : 'LIVE_REPLY_ADAPTER_UNAVAILABLE', message: isPrivate ? '侧车未提供 live_private' : '侧车未提供 live_reply' } };
        if (!ledger.batchId) return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'batch_not_planned' }, error: { code: 'LIVE_BATCH_NOT_PLANNED', message: '没有已冻结的批次，禁止发送' } };
        const limit = boundedInteger(params.maxSends, 1, 50, 10);
        let items;
        if (isPrivate) {
          // 私信只对【公屏已确认成功】的目标做，并逐项绑定那一次的 publicSendId：
          // 侧车会再校验一次（public_missing / public_* / public_send_mismatch），两侧一致。
          items = ledgerSnapshot(ledger)
            .filter((entry) => entry.public && entry.public.status === 'sent_confirmed' && entry.public.sendId)
            .slice(0, limit)
            .map((entry) => {
              const target = ledger.targets.find((item) => item.eventId === entry.eventId);
              return { eventId: entry.eventId, sendId: `${baseSendId}~private~${entry.eventId}`, publicSendId: entry.public.sendId, text: target?.privateText || '' };
            });
          if (!items.length) return { status: 'wait_human', checkpoint: { phase: 'private_message', reason: 'no_confirmed_public_delivery' }, error: { code: 'PUBLIC_DELIVERY_NOT_CONFIRMED', message: '没有公屏确认成功的目标，禁止私信' } };
        } else {
          items = (Array.isArray(ledger.targets) ? ledger.targets : []).slice(0, limit)
            .map((target) => ({ eventId: target.eventId, sendId: `${baseSendId}~public~${target.eventId}`, text: target.publicText || '' }));
          if (!items.length) return { status: 'wait_human', checkpoint: { phase: 'reply_public', reason: 'no_targets' }, error: { code: 'LIVE_BATCH_NO_TARGETS', message: '批次里没有可回复的目标' } };
        }
        const request = isPrivate
          ? { batchId: ledger.batchId, items }
          : { batchId: ledger.batchId, mode: ledger.replyMode || 'composer', items };
        const result = await method(request);
        const results = Array.isArray(result?.results) ? result.results : [];
        for (const item of results) {
          const eventId = optionalText(item?.eventId, 240);
          if (!eventId) continue;
          const entry = ledgerEntry(ledger, eventId);
          const record = {
            status: String(item?.status || 'unknown'),
            reason: resultText(item?.reason, 200),
            sendId: optionalText(item?.sendId, 300),
            recordedState: resultText(item?.recordedState, 60),
            roomEcho: item?.evidence?.roomEcho === true ? true : (item?.evidence?.roomEcho === false ? false : null),
            conversationEcho: item?.evidence?.conversationEcho === true ? true : (item?.evidence?.conversationEcho === false ? false : null),
            skipped: item?.evidence?.skipped === true
          };
          if (isPrivate) entry.private = record; else entry.public = record;
        }
        for (const item of Array.isArray(result?.skipped) ? result.skipped : []) {
          const eventId = optionalText(item?.eventId, 240);
          if (!eventId) continue;
          ledger.skipped.push({ eventId, reason: resultText(item?.reason, 120) });
          const entry = ledgerEntry(ledger, eventId);
          if (!entry.private) entry.private = { status: 'blocked', reason: resultText(item?.reason, 200), sendId: null, recordedState: null, roomEcho: null, conversationEcho: null, skipped: true };
        }
        const summary = resultSummary(items.map((item) => results.find((row) => row?.eventId === item.eventId)));
        const aggregate = aggregateSendStatus(summary, isPrivate ? 'private' : 'public');
        const checkpoint = { phase: step.stepId, batchId: ledger.batchId, attempted: summary.attempted, confirmed: summary.confirmed, unknown: summary.unknown, failed: summary.failed, blocked: summary.blocked, skipped: isPrivate ? ledger.skipped.length : 0, reason: resultText(result?.reason, 200) };
        // 统一台账：公屏与私信落在同一条记录上；私信额外带上"跳过"清单
        // （对方不可私信：未互关 / 私密账号 / 面板打不开 —— 一条消息都没发出去，单独记账）。
        const envelope = { deliveryStatus: aggregate.deliveryStatus, kind: isPrivate ? 'live_private' : 'live_reply', batchId: ledger.batchId, summary, ledger: ledgerSnapshot(ledger), counts: ledgerCounts(ledger) };
        if (isPrivate) envelope.skipped = [...ledger.skipped];
        if (aggregate.status === 'completed') return { status: 'completed', result: envelope, checkpoint };
        if (aggregate.status === 'wait_human') return { status: 'wait_human', result: envelope, checkpoint: { ...checkpoint, reason: checkpoint.reason || 'platform_blocked' }, error: { code: aggregate.code, message: isPrivate ? '私信被平台拦下，需要人工处理' : '公屏回复被平台拦下，需要人工处理' } };
        return { status: 'unknown', result: envelope, checkpoint, error: { code: aggregate.code, message: isPrivate ? '私信结果未被平台确认' : '公屏回复结果未被平台确认' } };
      }

      if (step.stepId === 'report') {
        if (typeof browser.liveResult !== 'function') return { status: 'failed', error: { code: 'LIVE_RESULT_ADAPTER_UNAVAILABLE', message: '侧车未提供 live_result' } };
        const result = ledger.batchId ? await browser.liveResult({ batchId: ledger.batchId }) : null;
        const counts = ledgerCounts(ledger);
        const checkpoint = {
          phase: 'report', batchId: ledger.batchId, counts,
          queue: queueSnapshot(result?.queue),
          platformCheckpoint: result?.checkpoint || null
        };
        return { status: 'completed', result: { kind: 'live_batch_ledger', batchId: ledger.batchId, ledger: ledgerSnapshot(ledger), skipped: [...ledger.skipped], counts }, checkpoint };
      }

      return { status: 'failed', error: { code: 'WORKFLOW_STEP_UNSUPPORTED', message: `未接入固定步骤 live.batch/${step.stepId}` } };
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
    const publicSendId = step.stepId === 'private_message' ? actionState.publicSendId : null;
    if (step.stepId === 'private_message' && !publicSendId) return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'public_delivery_id_missing' }, error: { code: 'PUBLIC_DELIVERY_ID_MISSING', message: '私信必须绑定已确认的公屏发送记录' } };
    if (step.stepId === 'private_message' && actionState.publicResult?.status !== 'sent_confirmed') return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'public_delivery_not_confirmed', publicSendId }, error: { code: 'PUBLIC_DELIVERY_NOT_CONFIRMED', message: '公屏回复尚未获得平台确认，禁止进入私信' } };
    if (step.stepId === 'private_message' && typeof browser.sendPrivate !== 'function') return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'private_adapter_unavailable' }, error: { code: 'PRIVATE_ADAPTER_UNAVAILABLE', message: '私信适配器不可用，已转人工' } };
    if (step.stepId !== 'private_message' && typeof browser.sendReply !== 'function') return { status: 'wait_human', checkpoint: { phase: step.stepId, reason: 'public_adapter_unavailable' }, error: { code: 'PUBLIC_ADAPTER_UNAVAILABLE', message: '公屏回复适配器不可用，已转人工' } };
    const result = step.stepId === 'private_message'
      ? await browser.sendPrivate(reply, { ...resolvedTarget, sendId, publicSendId })
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
