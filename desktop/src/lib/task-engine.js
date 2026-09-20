'use strict';

const crypto = require('node:crypto');
const { taskInput, safeIdempotencyKey } = require('./validation');
const { canAutoSend } = require('./selectors');

function now() { return new Date().toISOString(); }
function activeLicense(license) { const expires = Number(license?.user?.expiresAt); return Boolean(license && license.user?.status === 'active' && Number.isFinite(expires) && expires > Date.now()); }

class TaskEngine {
  constructor({ store, api, authStore, browser, selectorProfile, onStateChange, ensureLicense }) {
    this.store = store;
    this.api = api;
    this.authStore = authStore;
    this.browser = browser;
    this.selectorProfile = selectorProfile;
    this.onStateChange = onStateChange;
    this.ensureLicense = ensureLicense;
    this.license = authStore.getLicense();
    this.processing = Promise.resolve();
    this.inFlightActions = new Set();
    this.sendBusy = false;
    this.apiEpoch = 0;
    this.sessionEpoch = 0;
    this.#recoverStorage();
    this.#recoverSending();
  }

  setLicense(license) { this.license = license || null; if (license) this.authStore.setLicense(license); this.#notify(); }
  setApi(api) { this.api = api; this.apiEpoch += 1; this.sessionEpoch += 1; }
  invalidate(reason = 'session_changed') {
    this.sessionEpoch += 1;
    this.apiEpoch += 1;
    this.license = null;
    this.browser?.close?.();
    const data = this.store.get();
    let changed = false;
    for (const task of data.tasks) if (task.status === 'running') { task.status = 'offline'; task.generation = (task.generation || 0) + 1; changed = true; }
    if (changed) { this.#log(data, 'task_paused', { reason }); this.store.set(data); }
    this.#notify();
  }
  publicLicense() {
    const license = this.license;
    if (!license) return { state: 'unauthorized', user: null, balance: null, features: {} };
    return { user: license.user || null, balance: license.balance ?? null, features: license.features || {}, device: license.device || null, policy: license.policy || null, state: activeLicense(license) ? 'authorized' : 'expired' };
  }
  snapshot() { const data = this.store.get(); return { tasks: data.tasks, events: data.events.slice(-200).reverse(), leads: data.leads.slice(-200).reverse(), logs: data.logs.slice(-300).reverse(), pending: data.pending, license: this.publicLicense() }; }
  listTasks() { return this.store.get().tasks; }
  listLeads() { return this.store.get().leads.slice(-200).reverse(); }
  listLogs() { return this.store.get().logs.slice(-300).reverse(); }

  saveTask(input) {
    const task = taskInput(input);
    task.id = task.id || `task_${crypto.randomUUID()}`;
    task.decisionMode = input.decisionMode === 'ai' ? 'ai' : 'rule';
    task.updatedAt = now();
    const data = this.store.get();
    const index = data.tasks.findIndex((candidate) => candidate.id === task.id);
    if (index >= 0) {
      const previous = data.tasks[index];
      const changed = ['url', 'source', 'contactMode', 'businessContext', 'targetCustomer', 'keywords', 'excludeKeywords', 'replyTemplate', 'replyInstructions', 'mode', 'intervalMs', 'dailyLimit', 'maxActions', 'selectorProfileId', 'decisionMode'].some((key) => JSON.stringify(previous[key]) !== JSON.stringify(task[key]));
      const invalidates = changed || previous.status !== task.status;
      data.tasks[index] = { ...previous, ...task, generation: invalidates ? (previous.generation || 0) + 1 : previous.generation };
    }
    else data.tasks.push({ ...task, createdAt: now(), actionsToday: 0, sendAttemptsToday: 0, generationToday: 0, actionDay: now().slice(0, 10), lastSendAt: null, generation: 0 });
    this.#log(data, 'task_saved', { taskId: task.id });
    this.store.set(data); this.#notify(); return task;
  }

  deleteTask(taskId) { const data = this.store.get(); const wasRunning = data.tasks.some((task) => task.id === taskId && task.status === 'running'); data.tasks = data.tasks.filter((task) => task.id !== taskId); this.#log(data, 'task_deleted', { taskId }); this.store.set(data); if (wasRunning) this.browser.stop?.(); this.#notify(); }

  async setTaskStatus(taskId, status) {
    const data = this.store.get();
    const task = data.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error('任务不存在');
    if (!['running', 'paused', 'stopped'].includes(status)) throw new Error('不支持的任务状态');
    if (status === 'running' && task.decisionMode === 'rule' && !task.keywords.length) throw new Error('规则模式至少需要一个关键词，当前配置不能启动任务');
    if (status === 'running' && !activeLicense(this.license)) { task.status = 'license_required'; this.#log(data, 'task_blocked', { taskId, reason: 'license_required' }); this.store.set(data); this.#notify(); throw new Error('当前未授权，不能启动任务'); }
    if (status === task.status) return task;
    if (status === 'running' && typeof this.browser.isOpenFor === 'function' && !this.browser.isOpenFor(task.url)) { task.status = 'paused'; this.#log(data, 'task_blocked', { taskId, reason: 'target_not_open' }); this.store.set(data); this.#notify(); throw new Error('请先打开并登录当前任务的目标页面'); }
    if (status === 'running') for (const candidate of data.tasks) if (candidate.id !== taskId && candidate.status === 'running') { candidate.status = 'paused'; candidate.generation = (candidate.generation || 0) + 1; this.#log(data, 'task_paused', { taskId: candidate.id, reason: 'single_active_task' }); }
    task.status = status; task.generation = (task.generation || 0) + 1; if (status === 'running') this.#resetCounter(task);
    const startSession = this.sessionEpoch; const startGeneration = task.generation;
    this.#log(data, `task_${status}`, { taskId }); this.store.set(data);
    if (status !== 'running') this.browser.stop?.();
    if (status === 'running') {
      try { await this.browser.start(this.selectorProfile, task.source); }
      catch (error) {
        const failed = this.store.get();
        const current = failed.tasks.find((candidate) => candidate.id === task.id);
        if (current?.status === 'running' && current.generation === startGeneration && this.sessionEpoch === startSession) {
          current.status = 'offline';
          this.#log(failed, 'task_offline', { taskId, reason: error.code || error.message });
          this.store.set(failed); this.#notify();
          throw error;
        }
        return current || task;
      }
    }
    this.#notify(); return task;
  }

  pauseAll(reason = 'browser_navigation') {
    const data = this.store.get(); let changed = false;
    for (const task of data.tasks) if (task.status === 'running') { task.status = 'paused'; task.generation = (task.generation || 0) + 1; this.#log(data, 'task_paused', { taskId: task.id, reason }); changed = true; }
    if (changed) { this.browser.stop?.(); this.store.set(data); this.#notify(); }
  }

  ingest(events) {
    this.processing = this.processing.then(async () => {
      if (!Array.isArray(events)) return;
      const data = this.store.get();
      const activeTasks = data.tasks.filter((task) => task.status === 'running');
      const task = activeTasks[0];
      if (!task) return;
      for (const event of events.slice(0, 100)) await this.#processEvent(task.id, event);
    }).catch((error) => { console.error('[task-engine] ingest failed', error); });
    return this.processing;
  }

  async recheckSkipped(taskId) {
    const task = this.store.get().tasks.find((candidate) => candidate.id === taskId);
    const context = task ? { session: this.sessionEpoch, api: this.apiEpoch, generation: task.generation || 0, status: task.status } : null;
    const queued = this.processing.then(() => this.#recheckSkippedInner(taskId, context));
    this.processing = queued.catch(() => undefined);
    return queued;
  }

  async #recheckSkippedInner(taskId, context) {
    if (!activeLicense(this.license)) throw new Error('当前未授权，不能重新判定');
    await this.ensureLicense?.();
    if (!activeLicense(this.license)) throw new Error('授权刷新失败，不能重新判定');
    const first = this.store.get();
    const task = first.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error('任务不存在');
    if (task.mode !== 'manual' || task.decisionMode !== 'rule') throw new Error('仅支持手动规则任务重新判定');
    if (!task.keywords.length) throw new Error('规则模式至少需要一个关键词，不能重新判定');
    const capturedSession = context?.session;
    const capturedApi = context?.api;
    const capturedGeneration = context?.generation;
    const capturedStatus = context?.status;
    if (this.sessionEpoch !== capturedSession || this.apiEpoch !== capturedApi || task.generation !== capturedGeneration || task.status !== capturedStatus) return { evaluated: 0, queued: 0, skipped: 0, stopReason: 'context_changed', message: '任务配置、状态或授权会话已变化，未执行重新判定' };
    const eligibleReasons = new Set(['local_no_keyword', 'local_exclude', 'generation_budget_exhausted', 'local_keywords_missing']);
    const candidates = first.events.filter((event) => event.taskId === taskId && event.status === 'skipped' && eligibleReasons.has(event.reason) && this.#matchesRoom(task, event.roomId) && event.source === task.source && this.#neverSubmitted(event, first));
    const result = { evaluated: 0, queued: 0, skipped: 0 };
    for (const event of candidates) {
      const currentData = this.store.get();
      const currentTask = currentData.tasks.find((candidate) => candidate.id === taskId);
      if (!activeLicense(this.license)) { result.stopReason = 'authorization_changed'; result.message = '授权已失效，已停止本次重新判定'; break; }
      if (!currentTask || this.sessionEpoch !== capturedSession || this.apiEpoch !== capturedApi || currentTask.generation !== capturedGeneration || currentTask.status !== capturedStatus) { result.stopReason = 'context_changed'; result.message = '任务配置、状态或授权会话已变化，已停止本次重新判定'; break; }
      const currentEvent = currentData.events.find((candidate) => candidate.eventKey === event.eventKey);
      if (!currentEvent || currentEvent.status !== 'skipped' || !this.#neverSubmitted(currentEvent, currentData)) continue;
      const localReason = this.#localSkipReason(currentTask, currentEvent.text);
      if (localReason) { currentEvent.reason = localReason; this.store.set(currentData); result.skipped += 1; continue; }
      if (!this.#withinBudget(currentTask)) { result.stopReason = 'generation_budget_exhausted'; result.message = `当前判定额度已用尽（${currentTask.generationToday ?? 0}/${currentTask.maxActions || currentTask.dailyLimit}），请手动编辑任务提高判定上限后再试`; break; }
      const endpoint = this.api?.evaluate;
      if (typeof endpoint !== 'function') { result.stopReason = 'evaluation_failed'; result.message = '授权中心未提供当前判定模式'; break; }
      const idempotencyKey = safeIdempotencyKey(`draft:${currentEvent.eventKey}`);
      const requestEvent = { id: currentEvent.id, source: currentEvent.source === 'live' ? 'live_comment' : 'video_comment', roomId: currentEvent.roomId, authorId: currentEvent.authorId || `anonymous:${crypto.createHash('sha256').update(`${currentEvent.authorName || ''}|${currentEvent.text || ''}`).digest('hex').slice(0, 24)}`, authorName: currentEvent.authorName || '未知用户', text: currentEvent.text, observedAt: Number.isSafeInteger(Number(currentEvent.observedAt)) ? Number(currentEvent.observedAt) : (Date.parse(currentEvent.observedAt) || Date.now()) };
      const requestPayload = { event: requestEvent, rule: { keywords: currentTask.keywords, excludeKeywords: currentTask.excludeKeywords, replyTemplate: currentTask.replyTemplate }, idempotencyKey };
      currentEvent.status = 'evaluating'; currentEvent.idempotencyKey = idempotencyKey; currentEvent.requestMethod = 'evaluate'; currentEvent.requestPayload = requestPayload; currentEvent.draftRequest = requestPayload; currentTask.generationToday = (currentTask.generationToday || 0) + 1;
      currentData.tasks = currentData.tasks.map((candidate) => candidate.id === taskId ? currentTask : candidate);
      this.store.set(currentData); this.#notify();
      result.evaluated += 1;
      try {
        const draft = await endpoint.call(this.api, requestPayload);
        const next = this.store.get(); const latestTask = next.tasks.find((candidate) => candidate.id === taskId); const latest = next.events.find((candidate) => candidate.eventKey === event.eventKey);
        if (!latest || !latestTask || this.sessionEpoch !== capturedSession || this.apiEpoch !== capturedApi || latestTask.generation !== capturedGeneration || latestTask.status !== capturedStatus) { if (latest) { latest.status = 'evaluation_unknown'; latest.reason = 'recheck_context_changed'; this.store.set(next); } result.stopReason = 'context_changed'; result.message = '任务配置、状态或授权会话已变化，已停止本次重新判定'; break; }
        this.#applyDraftResult(next, latestTask, latest, draft, currentEvent.eventKey); if (draft.matched === true && draft.reply) result.queued += 1; else result.skipped += 1; this.store.set(next); this.#notify();
      } catch (error) {
        const next = this.store.get(); const latest = next.events.find((candidate) => candidate.eventKey === event.eventKey); if (latest) { latest.status = 'evaluation_unknown'; latest.reason = error.code || error.message; this.store.set(next); } result.stopReason = 'evaluation_failed'; result.message = error.message || '判定结果未确认'; break;
      }
    }
    this.#notify(); return result;
  }

  #neverSubmitted(event, data) {
    if (event.requestPayload || event.draftRequest || event.idempotencyKey || event.actionId || event.sendId || event.sendStartedAt) return false;
    return !data.pending.some((candidate) => candidate.eventKey === event.eventKey) && !data.logs.some((log) => log.detail?.eventKey === event.eventKey && ['send_started', 'reply_attempted'].includes(log.type));
  }

  async confirmAction(actionId) {
    if (this.inFlightActions.has(actionId)) throw new Error('回复正在执行');
    if (this.sendBusy) throw new Error('已有回复正在执行，请稍后再试');
    const first = this.store.get();
    const action = first.pending.find((candidate) => candidate.actionId === actionId);
    if (!action) throw new Error('待确认回复不存在');
    if (action.sendStartedAt) return { status: 'unknown', reason: 'send_was_started_before_restart' };
    const task = first.tasks.find((candidate) => candidate.id === action.taskId);
    if (!task || task.status !== 'running') throw new Error('任务已暂停，不能发送');
    if (!activeLicense(this.license)) throw new Error('授权已失效，停止发送');
    if (!this.#cooldownReady(task)) throw new Error('仍在发送冷却期，请稍后再试');
    this.sendBusy = true;
    this.inFlightActions.add(actionId);
    const capturedSession = this.sessionEpoch;
    let sendStarted = false;
    let sendId = action.sendId || `send_${crypto.randomUUID()}`;
    try {
      await this.ensureLicense?.();
      if (capturedSession !== this.sessionEpoch) return { status: 'unknown', reason: 'session_changed' };
      if (!activeLicense(this.license)) throw new Error('授权刷新失败，停止发送');
      const mark = this.store.get();
      const currentAction = mark.pending.find((candidate) => candidate.actionId === actionId);
      const currentTask = mark.tasks.find((candidate) => candidate.id === action.taskId);
      if (!currentAction || currentAction.sendStartedAt || !currentTask || currentTask.status !== 'running') return { status: 'unknown', reason: 'send_state_changed' };
      if (!this.#cooldownReady(currentTask)) throw new Error('仍在发送冷却期，请稍后再试');
      if (!this.#sendBudgetReady(currentTask)) throw new Error('已达到本地发送上限，任务已暂停');
      currentAction.sendStartedAt = now();
      currentAction.sendId = currentAction.sendId || sendId;
      sendId = currentAction.sendId;
      const currentEvent = mark.events.find((candidate) => candidate.eventKey === action.eventKey);
      if (currentEvent) { currentEvent.status = 'sending'; currentEvent.sendId = sendId; currentEvent.updatedAt = now(); }
      currentTask.lastSendAt = currentAction.sendStartedAt;
      currentTask.actionsToday = (currentTask.actionsToday || 0) + 1;
      currentTask.sendAttemptsToday = (currentTask.sendAttemptsToday || 0) + 1;
      mark.tasks = mark.tasks.map((candidate) => candidate.id === currentTask.id ? currentTask : candidate);
      this.#log(mark, 'send_started', { actionId, sendId });
      this.store.set(mark);
      sendStarted = true;
      const target = { id: currentEvent?.platformId || '', text: currentEvent?.text || '', authorId: currentEvent?.authorId || '', authorName: currentEvent?.authorName || '', fingerprint: currentEvent?.fingerprint || '', roomId: currentEvent?.roomId || '', sendId };
      const result = currentAction.channel === 'private' && typeof this.browser.sendPrivate === 'function' ? await this.browser.sendPrivate(currentAction.reply, target) : await this.browser.sendReply(currentAction.reply, currentAction.source, target);
      if (capturedSession !== this.sessionEpoch) return { status: 'unknown', reason: 'session_changed' };
      const next = this.store.get();
      const latestTask = next.tasks.find((candidate) => candidate.id === action.taskId);
      const effectiveResult = latestTask?.status === 'running' && latestTask.generation === currentTask.generation ? result : { status: 'unknown', reason: 'task_changed_during_send' };
      const event = next.events.find((candidate) => candidate.eventKey === action.eventKey);
      if (event) { event.status = effectiveResult.status === 'unknown' ? 'sent_unknown' : 'failed'; event.sendResult = effectiveResult; event.updatedAt = now(); }
      next.pending = next.pending.filter((candidate) => candidate.actionId !== actionId);
      this.#log(next, 'reply_attempted', { actionId, sendId, status: effectiveResult.status, reason: effectiveResult.reason || null });
      this.store.set(next); this.#notify(); return effectiveResult;
    } catch (error) {
      if (!sendStarted) throw error;
      if (capturedSession !== this.sessionEpoch) return { status: 'unknown', reason: 'session_changed' };
      const next = this.store.get();
      const event = next.events.find((candidate) => candidate.eventKey === action.eventKey);
      if (event) { event.status = 'sent_unknown'; event.reason = error.message; event.updatedAt = now(); }
      next.pending = next.pending.filter((candidate) => candidate.actionId !== actionId);
      this.#log(next, 'reply_attempted', { actionId, sendId, status: 'unknown', reason: error.message });
      this.store.set(next); this.#notify(); return { status: 'unknown', reason: 'send_exception' };
    } finally { this.inFlightActions.delete(actionId); this.sendBusy = false; }
  }

  async retryDraft(eventKey) {
    const first = this.store.get();
    const event = first.events.find((candidate) => candidate.eventKey === eventKey);
    const task = event && first.tasks.find((candidate) => candidate.id === event.taskId);
    if (!event || !task || !event.draftRequest) throw new Error('没有可恢复的生成请求');
    if (!['evaluation_unknown', 'failed'].includes(event.status)) throw new Error('当前事件不需要恢复生成');
    if (!activeLicense(this.license)) throw new Error('授权已失效，停止生成');
    await this.ensureLicense?.();
    if (!activeLicense(this.license)) throw new Error('授权刷新失败，停止生成');
    const capturedSession = this.sessionEpoch;
    const requestEpoch = this.apiEpoch;
    const requestMethod = event.requestMethod || (task.decisionMode === 'ai' ? 'draft' : 'evaluate');
    const requestPayload = event.requestPayload || event.draftRequest;
    const endpoint = requestMethod === 'draft' ? this.api.draft : this.api.evaluate;
    if (typeof endpoint !== 'function') throw new Error('授权中心未提供当前判定模式');
    const mark = this.store.get();
    const current = mark.events.find((candidate) => candidate.eventKey === eventKey);
    if (!current || current.status === 'awaiting_confirmation' || mark.pending.some((candidate) => candidate.eventKey === eventKey)) return;
    current.status = 'evaluating'; current.requestMethod = requestMethod; current.requestPayload = requestPayload; current.draftRequest = requestPayload; current.updatedAt = now();
    this.store.set(mark); this.#notify();
    try {
      const draft = await endpoint.call(this.api, current.requestPayload);
      const next = this.store.get();
      const latest = next.events.find((candidate) => candidate.eventKey === eventKey);
      const latestTask = next.tasks.find((candidate) => candidate.id === task.id);
      if (!latest || !latestTask || capturedSession !== this.sessionEpoch || requestEpoch !== this.apiEpoch) return;
      this.#applyDraftResult(next, latestTask, latest, draft, eventKey);
      this.store.set(next); this.#notify();
      // Recovery only restores the generated result to the confirmation queue.
      // It must never turn a network retry into an implicit send.
    } catch (error) {
      const next = this.store.get(); const current = next.events.find((candidate) => candidate.eventKey === eventKey);
      if (current) { current.status = 'evaluation_unknown'; current.reason = error.code || error.message; current.updatedAt = now(); }
      this.#log(next, 'draft_recovery_failed', { eventKey, code: error.code || 'unknown' }); this.store.set(next); this.#notify();
      throw error;
    }
  }

  #processEvent(taskId, sourceEvent) {
    return this.#processEventInner(taskId, sourceEvent);
  }

  async #processEventInner(taskId, sourceEvent) {
    const first = this.store.get();
    const task = first.tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.status !== 'running' || !this.#matchesRoom(task, sourceEvent.roomId)) return;
    const fingerprint = String(sourceEvent.fingerprint || sourceEvent.id || `${sourceEvent.source}:${sourceEvent.text}`);
    const eventKey = `${sourceEvent.source || task.source}:${crypto.createHash('sha256').update(fingerprint).digest('hex')}`;
    if (first.events.some((candidate) => candidate.eventKey === eventKey)) return;
    const data = this.store.get();
    const platformId = String(sourceEvent.id || '').slice(0, 240);
    const event = { ...sourceEvent, source: sourceEvent.source === 'live' || sourceEvent.source === 'live_comment' || sourceEvent.source === 'live_danmaku' ? 'live' : 'video', platformSource: sourceEvent.source, platformId, id: crypto.createHash('sha256').update(`${eventKey}:${sourceEvent.observedAt || ''}`).digest('hex'), eventKey, taskId, status: 'observed', observedAt: sourceEvent.observedAt || now(), createdAt: now() };
    data.events.push(event); this.#log(data, 'event_observed', { taskId, eventKey, source: event.source });
    const recentSelfOutput = sourceEvent.authorId && first.events.some((candidate) => candidate.taskId === taskId && candidate.roomId === sourceEvent.roomId && candidate.authorId === sourceEvent.authorId && candidate.text === sourceEvent.text && ['sending', 'sent_unknown'].includes(candidate.status));
    if (recentSelfOutput) { event.status = 'skipped'; event.reason = 'recent_self_reply'; this.#log(data, 'event_skipped', { taskId, eventKey, reason: event.reason }); this.store.set(data); this.#notify(); return; }
    const localReason = this.#localSkipReason(task, event.text);
    if (localReason || !this.#withinBudget(task)) {
      event.status = 'skipped'; event.reason = localReason || 'generation_budget_exhausted'; this.#log(data, 'event_skipped', { taskId, eventKey, reason: event.reason }); this.store.set(data); this.#notify(); return;
    }
    const sendChannel = task.contactMode === 'private' ? 'private' : task.source;
    const sendReady = typeof this.browser.canSend === 'function' ? this.browser.canSend(sendChannel) : canAutoSend(this.selectorProfile, task.source);
    if (task.mode === 'auto' && !sendReady) { event.status = 'skipped'; event.reason = 'sender_capability_unverified'; this.#log(data, 'event_skipped', { taskId, eventKey, reason: event.reason }); this.store.set(data); this.#notify(); return; }
    if (!activeLicense(this.license) || (this.license.balance != null && Number(this.license.balance) < 0)) { event.status = 'skipped'; event.reason = 'license_required'; this.store.set(data); this.#notify(); return; }
    const idempotencyKey = safeIdempotencyKey(`draft:${eventKey}`); const capturedGeneration = task.generation || 0; const capturedSession = this.sessionEpoch; const requestEpoch = this.apiEpoch; const requestMethod = task.decisionMode === 'ai' ? 'draft' : 'evaluate'; const observedAt = Number.isSafeInteger(Number(event.observedAt)) ? Number(event.observedAt) : (Date.parse(event.observedAt) || Date.now()); const requestAuthorId = event.authorId || `anonymous:${crypto.createHash('sha256').update(`${event.authorName || ''}|${event.text || ''}`).digest('hex').slice(0, 24)}`; const requestEvent = { id: event.id, source: event.source === 'live' ? 'live_comment' : 'video_comment', roomId: event.roomId, authorId: requestAuthorId, authorName: event.authorName || '未知用户', text: event.text, observedAt }; const requestPayload = requestMethod === 'draft' ? { event: requestEvent, businessContext: task.businessContext, targetCustomer: task.targetCustomer, replyInstructions: task.replyInstructions, idempotencyKey } : { event: requestEvent, rule: { keywords: task.keywords, excludeKeywords: task.excludeKeywords, replyTemplate: task.replyTemplate }, idempotencyKey }; event.status = 'evaluating'; event.idempotencyKey = idempotencyKey; event.requestMethod = requestMethod; event.requestPayload = requestPayload; event.draftRequest = requestPayload; task.generationToday = (task.generationToday || 0) + 1; data.tasks = data.tasks.map((candidate) => candidate.id === task.id ? task : candidate); this.store.set(data); this.#notify();
    try {
      const endpoint = requestMethod === 'draft' ? this.api.draft : this.api.evaluate;
      if (typeof endpoint !== 'function') throw new Error('授权中心未提供当前判定模式');
      const draft = await endpoint.call(this.api, requestPayload);
      const next = this.store.get(); const current = next.events.find((candidate) => candidate.eventKey === eventKey); const latestTask = next.tasks.find((candidate) => candidate.id === task.id);
      if (!current || !latestTask) return;
      if (capturedSession !== this.sessionEpoch || requestEpoch !== this.apiEpoch || (latestTask.generation || 0) !== capturedGeneration) { return; }
      this.#applyDraftResult(next, latestTask, current, draft, eventKey);
      this.store.set(next); this.#notify();
      const after = this.store.get().tasks.find((candidate) => candidate.id === task.id);
      if (task.mode === 'auto' && after?.status === 'running' && current.status === 'awaiting_confirmation') await this.confirmAction(current.actionId);
    } catch (error) {
      const next = this.store.get(); const current = next.events.find((candidate) => candidate.eventKey === eventKey); if (current) { current.status = error.code === 'NETWORK_ERROR' || error.status === 0 ? 'evaluation_unknown' : 'failed'; current.reason = error.code || error.message; current.updatedAt = now(); } this.#log(next, 'draft_failed', { taskId: task.id, eventKey, code: error.code || 'unknown' }); this.store.set(next); this.#notify();
    }
  }

  #applyDraftResult(data, task, event, draft, eventKey) {
    Object.assign(event, { matched: draft.matched === true, intent: draft.intent || 'unknown', confidence: draft.confidence ?? null, reason: draft.reason || '', reply: draft.reply || '', charged: Number.isFinite(Number(draft.charged)) ? Number(draft.charged) : 0, balance: draft.balance ?? null, actionId: draft.actionId || null, status: draft.matched && draft.reply ? 'matched' : 'skipped', updatedAt: now() });
    if (draft.matched === true && draft.reply) {
      const actionId = draft.actionId || `action_${crypto.randomUUID()}`;
      if (!data.pending.some((candidate) => candidate.eventKey === eventKey)) data.pending.push({ actionId, sendId: `send_${crypto.randomUUID()}`, eventKey, taskId: task.id, source: event.source, channel: task.contactMode || 'comment', reply: draft.reply, createdAt: now() });
      event.actionId = actionId; event.status = 'awaiting_confirmation';
      this.#upsertLead(data, task, event);
      this.#log(data, 'reply_drafted', { taskId: task.id, eventKey, actionId, charged: event.charged, balance: draft.balance ?? null });
    } else this.#log(data, 'event_judged', { taskId: task.id, eventKey, matched: draft.matched === true, charged: event.charged });
  }

  #upsertLead(data, task, event) { const key = `${task.id}:${event.authorName || ''}:${event.text}`; if (!data.leads.some((lead) => lead.key === key)) data.leads.push({ key, taskId: task.id, authorName: event.authorName || '未知用户', intent: event.intent, confidence: event.confidence, reason: event.reason, text: event.text, status: 'new', updatedAt: now() }); }
  #matchesRoom(task, roomId) { try { const target = new URL(task.url); const actual = new URL(roomId); return target.hostname === actual.hostname && target.pathname === actual.pathname; } catch (error) { return false; } }
  #localSkipReason(task, content) { const value = String(content || '').toLowerCase(); if (!value) return 'empty'; if (task.decisionMode === 'rule' && !task.keywords.length) return 'local_keywords_missing'; if (task.excludeKeywords.some((keyword) => value.includes(keyword.toLowerCase()))) return 'local_exclude'; if (task.decisionMode === 'rule' && !task.keywords.some((keyword) => value.includes(keyword.toLowerCase()))) return 'local_no_keyword'; return null; }
  #withinBudget(task) { this.#resetCounter(task); const limit = task.maxActions || task.dailyLimit; return Number.isInteger(limit) && limit > 0 && (task.generationToday ?? task.actionsToday ?? 0) < limit; }
  #sendBudgetReady(task) { this.#resetCounter(task); const limit = task.dailyLimit || task.maxActions; return Number.isInteger(limit) && limit > 0 && (task.sendAttemptsToday ?? task.actionsToday ?? 0) < limit; }
  #cooldownReady(task) { if (!task.lastSendAt || !task.intervalMs) return true; const stamp = Date.parse(task.lastSendAt); return Number.isFinite(stamp) && Date.now() - stamp >= task.intervalMs; }
  #resetCounter(task) { const day = now().slice(0, 10); if (task.actionDay !== day) { task.actionDay = day; task.actionsToday = 0; task.sendAttemptsToday = 0; task.generationToday = 0; } }
  #log(data, type, detail) { data.logs.push({ id: `log_${crypto.randomUUID()}`, type, at: now(), detail }); if (data.logs.length > 1000) data.logs = data.logs.slice(-1000); }
  #recoverSending() { const data = this.store.get(); let changed = false; for (const task of data.tasks) if (task.status === 'running') { task.status = 'paused'; task.generation = (task.generation || 0) + 1; this.#log(data, 'task_paused', { taskId: task.id, reason: 'desktop_restarted_without_active_collector' }); changed = true; } for (const event of data.events) { if (event.status === 'sending') { event.status = 'sent_unknown'; event.reason = 'desktop_restarted_after_send_started'; changed = true; } } data.pending = data.pending.filter((action) => { if (action.sendStartedAt) { changed = true; return false; } return true; }); if (changed) this.store.set(data); }
  #recoverStorage() { if (!this.store.recoveryRequired) return; const data = this.store.get(); for (const task of data.tasks) if (task.status === 'running') task.status = 'offline'; this.#log(data, 'storage_recovery_required', { reason: 'primary_record_invalid_or_incomplete' }); this.store.set(data); }
  #isLicensed() { return activeLicense(this.license); }
  #notify() { this.onStateChange?.(this.snapshot()); }
}

module.exports = { TaskEngine, activeLicense };
