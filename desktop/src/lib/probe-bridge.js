'use strict';

const { ProbeClient } = require('./probe-client');
const { targetUrl } = require('./validation');

function asStatus(result) { return result && typeof result.status === 'string' ? result.status : 'unknown'; }
function sendTimeoutMs(text) { return 60000 + Math.ceil(String(text || '').length * 60); }
function validEvents(result, source) {
  if (!result || !Array.isArray(result.events)) throw new Error('侧车采集结果格式无效');
  return result.events.filter((event) => event && typeof event.text === 'string' && typeof event.roomId === 'string').map((event) => ({ ...event, source: event.source || source }));
}
function platformResponseConfirmed(item) {
  const validation = item?.validation;
  return validation?.delivery === 'platform_response_confirmed' || validation?.platform_response_confirmed === true;
}

class ProbeBridge {
  constructor({ accountDir, port, onStatus, onEvents, resourcesPath, cwd, env, packaged = false } = {}) {
    this.onStatus = onStatus;
    this.onEvents = onEvents;
    this.client = new ProbeClient({ accountDir, port, resourcesPath, cwd, env, packaged, onProgress: (data) => this.onStatus?.({ progress: data }) });
    this.isSidecar = true;
    this.currentUrl = null;
    this.source = 'video';
    this.timer = null;
    this.running = false;
    this.collectEpoch = 0;
    this.collectRunning = false;
    this.lifecycleEpoch = 0;
    this.closed = false;
    this.closePromise = null;
    this.capability = { verified: false, source: null, detail: '侧车尚未完成能力探测' };
    this.sendCapability = { verified: false, source: null, detail: '发送能力尚未验证' };
    this.privateCapability = { verified: false, detail: '私信能力尚未验证' };
    this.launchPromise = null;
    this.remoteOwned = false;
    this.lifecyclePromise = Promise.resolve();
    this.lifecycleOperation = 0;
    this.cancelGeneration = 0;
    this.startOperation = null;
    this.openPending = 0;
  }

  #enqueueLifecycle(work) {
    const operation = ++this.lifecycleOperation;
    const run = this.lifecyclePromise.then(() => work(operation), () => work(operation));
    this.lifecyclePromise = run.catch(() => {});
    return run;
  }

  async #waitForIdleOrThrow() {
    if (await this.client.waitForIdle(3000)) return;
    this.client.cancel();
    if (await this.client.waitForIdle(3000)) return;
    const error = new Error('侧车仍在执行上一个操作，请稍后重试');
    error.code = 'SIDECAR_BUSY';
    throw error;
  }

  async #launch() {
    if (!this.launchPromise) this.launchPromise = this.client.request('launch', {}, { timeoutMs: 60000 }).then((result) => {
      this.remoteOwned = Number.isInteger(result?.browser?.pid) && result.browser.pid > 0;
      return result;
    }).catch((error) => { this.launchPromise = null; throw error; });
    return this.launchPromise;
  }

  #reportOpenFailure(error, message = error?.message || '页面打开失败') {
    this.currentUrl = null;
    this.onStatus?.({ connected: false, collector: 'open_error', url: null, matchCount: 0, error: message });
  }

  async open(url) {
    const requested = targetUrl(url);
    const generation = this.cancelGeneration;
    this.openPending += 1;
    const promise = this.#enqueueLifecycle(async (operation) => {
      if (generation !== this.cancelGeneration) throw new Error('页面打开操作已取消');
      if (this.closePromise) await this.closePromise;
      if (generation !== this.cancelGeneration) throw new Error('页面打开操作已取消');
      this.closed = false;
      this.#stopForTransition();
      this.currentUrl = null;
      const epoch = this.lifecycleEpoch;
      try {
        await this.#waitForIdleOrThrow();
      } catch (error) {
        if (epoch === this.lifecycleEpoch && generation === this.cancelGeneration) this.#reportOpenFailure(error);
        throw error;
      }
      if (epoch !== this.lifecycleEpoch || generation !== this.cancelGeneration) throw new Error('页面打开操作已取消');
      let result;
      let recovered = false;
      while (!result) {
        if (epoch !== this.lifecycleEpoch || generation !== this.cancelGeneration) throw new Error('页面打开操作已取消');
        try {
          await this.#launch();
          if (epoch !== this.lifecycleEpoch || generation !== this.cancelGeneration) throw new Error('页面打开操作已取消');
          result = await this.client.request('open', { url: requested }, { timeoutMs: 60000 });
        } catch (error) {
          if (epoch !== this.lifecycleEpoch || generation !== this.cancelGeneration) throw new Error('页面打开操作已取消');
          const recoverable = error?.code === 'target_not_found' || error?.code === 'browser_unavailable';
          if (!recoverable || recovered) {
            if (recoverable) {
              error.message = '专用浏览器目标不可用，恢复失败，请重新打开浏览器会话';
            }
            this.#reportOpenFailure(error);
            throw error;
          }
          recovered = true;
          this.launchPromise = null;
          this.remoteOwned = false;
        }
      }
      if (epoch !== this.lifecycleEpoch || generation !== this.cancelGeneration) throw new Error('页面打开操作已取消');
      this.currentUrl = result.url ? targetUrl(result.url) : requested;
      this.onStatus?.({ connected: true, collector: 'open', url: this.currentUrl, matchCount: 0, error: null, status: asStatus(result), operation });
      return this.currentUrl;
    }).finally(() => { this.openPending -= 1; });
    return promise;
  }

  async search(keyword, maxVideos = 20, scrollRounds = 2, options = {}) {
    await this.#launch();
    const params = keyword && typeof keyword === 'object'
      ? keyword
      : { keyword, maxVideos, scrollRounds, ...options };
    return this.client.request('search', params, { timeoutMs: 60000 });
  }

  async searchPool(params = {}) {
    return this.client.request('search_pool', params, { timeoutMs: 20000 });
  }

  async collectOnce(source, url, options = {}) {
    const requested = targetUrl(url);
    this.source = source === 'live' ? 'live' : 'video';
    await this.#launch();
    if (!this.currentUrl || !this.isOpenFor(requested)) {
      const opened = await this.open(requested);
      if (opened) this.currentUrl = opened;
    }
    try {
      await this.#probeCapability(source);
    } catch (error) {
      this.onStatus?.({ connected: false, collector: 'capability_error', status: 'unsupported', error: error.message });
      return { status: 'unsupported', events: [], capability: this.capability, error: error.message };
    }
    const method = source === 'live' ? 'collect_live' : 'collect_comments';
    const params = source === 'live'
      ? { url: this.currentUrl || requested, maxItems: Number.isInteger(options.maxItems) ? options.maxItems : 100 }
      : { url: this.currentUrl || requested, maxItems: Number.isInteger(options.maxItems) ? options.maxItems : 100, scrollRounds: Number.isInteger(options.scrollRounds) ? options.scrollRounds : 0 };
    const result = await this.client.request(method, params, { timeoutMs: 45000 });
    const events = validEvents(result, source);
    this.onStatus?.({ connected: true, collector: result.status || 'ready', status: result.status || 'ready', matchCount: events.length, capability: result.capability || this.capability });
    return { ...result, events };
  }

  isOpenFor(url) {
    try { const expected = new URL(url); const actual = new URL(this.currentUrl || ''); return expected.hostname === actual.hostname && expected.pathname === actual.pathname; } catch (error) { return false; }
  }

  start(_profile, source = 'video') {
    if (this.startOperation && this.startOperation.source === source && this.startOperation.generation === this.cancelGeneration) return this.startOperation.promise;
    if (this.running && this.source === source && this.openPending === 0) return;
    const generation = this.cancelGeneration;
    const promise = this.#enqueueLifecycle(async (operation) => {
      if (generation !== this.cancelGeneration) return;
      if (this.closed) throw new Error('侧车已关闭，请重新打开浏览器会话');
      if (this.running) this.#stopForTransition();
      const epoch = ++this.lifecycleEpoch;
      this.source = source;
      this.running = true;
      try {
        await this.#waitForIdleOrThrow();
        if (epoch !== this.lifecycleEpoch || generation !== this.cancelGeneration) return;
        await this.#probeCapability(source, () => epoch === this.lifecycleEpoch && generation === this.cancelGeneration);
        if (epoch !== this.lifecycleEpoch || generation !== this.cancelGeneration) return;
        const collectEpoch = ++this.collectEpoch;
        await this.#collect(collectEpoch);
        if (epoch !== this.lifecycleEpoch || generation !== this.cancelGeneration) return;
        this.#scheduleCollect(collectEpoch);
      } catch (error) {
        if (epoch !== this.lifecycleEpoch || generation !== this.cancelGeneration) return;
        this.running = false;
        throw error;
      }
    });
    this.startOperation = { source, generation, promise };
    promise.finally(() => { if (this.startOperation?.promise === promise) this.startOperation = null; }).catch(() => {});
    return promise;
  }

  stop() {
    this.cancelGeneration += 1;
    this.#stopForTransition();
  }

  #stopForTransition() {
    this.lifecycleEpoch += 1;
    this.running = false;
    this.collectEpoch += 1;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.client.busy) this.client.cancel();
  }

  #setCapabilities(capability, source) {
    const captureKey = source === 'live' ? 'live_capture' : 'video_capture';
    const replyKey = source === 'live' ? 'live_reply' : source === 'private' ? 'private_reply' : 'video_reply';
    const capture = capability?.[captureKey] || {};
    const reply = capability?.[replyKey] || {};
    const captureVerified = capture.implemented === true;
    const replyVerified = reply.implemented === true;
    this.capability = { verified: captureVerified, source, implemented: captureVerified, autoEligible: capture.autoEligible === true && platformResponseConfirmed(capture), validation: capture.validation || null, evidence: capture.evidence || null, detail: captureVerified ? `侧车已声明${captureKey}能力` : `侧车未声明${captureKey}能力` };
    this.sendCapability = { verified: replyVerified, implemented: replyVerified, autoEligible: reply.autoEligible === true && platformResponseConfirmed(reply), source, validation: reply.validation || null, evidence: reply.evidence || null, detail: replyVerified ? `侧车已声明${replyKey}能力，发送结果仍须运行时核实` : `侧车未声明${replyKey}能力` };
    const privateReply = capability?.private_reply || {};
    this.privateCapability = { verified: privateReply.implemented === true, implemented: privateReply.implemented === true, autoEligible: privateReply.autoEligible === true && platformResponseConfirmed(privateReply), validation: privateReply.validation || null, evidence: privateReply.evidence || null, detail: privateReply.implemented === true ? '侧车已声明私信能力，发送结果仍须运行时核实' : '私信发送未声明' };
  }

  async #probeCapability(source, isCurrent = () => true) {
    try {
      const result = await this.client.request('capabilities', {}, { timeoutMs: 20000 });
      if (!isCurrent()) return;
      this.#setCapabilities(result?.capability || {}, source);
    } catch (error) {
      if (!isCurrent()) return;
      this.capability = { verified: false, source, detail: error.message };
      this.sendCapability = { verified: false, source, detail: error.message };
      this.privateCapability = { verified: false, detail: error.message };
      throw error;
    }
  }

  canSend(source = this.source) { return source === 'private' ? this.privateCapability.implemented === true && this.privateCapability.autoEligible === true : this.sendCapability.implemented === true && this.sendCapability.autoEligible === true && this.sendCapability.source === source; }

  #scheduleCollect(epoch) {
    if (!this.running || epoch !== this.collectEpoch) return;
    this.timer = setTimeout(async () => {
      if (!this.running || epoch !== this.collectEpoch) return;
      try { await this.#collect(epoch); } catch (error) { this.onStatus?.({ collector: 'error', error: error.message }); }
      this.#scheduleCollect(epoch);
    }, 2500);
  }

  async #collect(epoch = this.collectEpoch) {
    if (!this.running || epoch !== this.collectEpoch || !this.currentUrl || this.collectRunning) return;
    this.collectRunning = true;
    const method = this.source === 'live' ? 'collect_live' : 'collect_comments';
    const params = this.source === 'live' ? { url: this.currentUrl, maxItems: 100 } : { url: this.currentUrl, maxItems: 100, scrollRounds: 0 };
    try {
      const result = await this.client.request(method, params, { timeoutMs: 45000 });
      if (epoch !== this.collectEpoch || !this.running) return;
      const events = validEvents(result, this.source);
      const terminal = ['captcha', 'login_required', 'unsupported'].includes(result.status);
      if (terminal) this.running = false;
      this.onStatus?.({ connected: true, collector: result.status || 'ready', status: result.status || 'ready', matchCount: events.length, capability: result.capability || this.capability });
      if (events.length) this.onEvents?.(events);
    } finally { this.collectRunning = false; }
  }

  async probe(_profile) {
    const result = await this.client.request('capabilities', {}, { timeoutMs: 20000 });
    const capability = result?.capability || {};
    this.#setCapabilities(capability, this.source);
    return { transport: 'sidecar', capability, diagnostics: result.diagnostics || result.detail || null, sample: [], url: this.currentUrl, verified: this.capability.verified, sendCapability: this.sendCapability };
  }

  async sendReply(replyText, source, eventTarget) {
    if (!this.currentUrl || source !== this.source) return { status: 'blocked', reason: 'sidecar_target_not_open' };
    const sendId = eventTarget?.sendId;
    if (!sendId) return { status: 'blocked', reason: 'send_id_missing' };
    const operationEpoch = this.lifecycleEpoch;
    const resume = this.running;
    this.#pauseForSend();
    while (this.collectRunning) await new Promise((resolve) => setTimeout(resolve, 20));
    if (this.closed || this.lifecycleEpoch !== operationEpoch) return { status: 'unknown', sendId, reason: 'sidecar_operation_cancelled_before_send' };
    try {
      const result = await this.client.request('send_comment', { sendId, target: { id: eventTarget?.id || '', roomId: eventTarget?.roomId || this.currentUrl, authorId: eventTarget?.authorId || '', authorName: eventTarget?.authorName || '', text: eventTarget?.text || '' }, text: replyText, source }, { timeoutMs: sendTimeoutMs(replyText) });
      this.#resumeAfterSend(operationEpoch, resume);
      return { ...result, sendId };
    } catch (error) {
      this.#resumeAfterSend(operationEpoch, resume);
      return { status: 'unknown', sendId, reason: error.code === 'SIDECAR_TIMEOUT' || error.code === 'SIDECAR_NO_FINAL' ? 'sidecar_result_unknown' : error.message };
    }
  }

  async sendPrivate(replyText, eventTarget) {
    const sendId = eventTarget?.sendId;
    if (!sendId || !eventTarget?.authorId) return { status: 'blocked', reason: 'private_target_identity_missing' };
    const operationEpoch = this.lifecycleEpoch;
    const resume = this.running;
    this.#pauseForSend();
    while (this.collectRunning) await new Promise((resolve) => setTimeout(resolve, 20));
    if (this.closed || this.lifecycleEpoch !== operationEpoch) return { status: 'unknown', sendId, reason: 'sidecar_operation_cancelled_before_send' };
    try {
      const request = { sendId, target: { authorId: eventTarget.authorId, authorName: eventTarget.authorName }, text: replyText };
      if (eventTarget.publicSendId) request.publicSendId = eventTarget.publicSendId;
      const result = await this.client.request('send_private', request, { timeoutMs: sendTimeoutMs(replyText) });
      this.#resumeAfterSend(operationEpoch, resume);
      return { ...result, sendId };
    } catch (error) {
      this.#resumeAfterSend(operationEpoch, resume);
      return { status: 'unknown', sendId, reason: error.code === 'SIDECAR_TIMEOUT' || error.code === 'SIDECAR_NO_FINAL' ? 'sidecar_result_unknown' : error.message };
    }
  }

  async commentPrivateCandidates(items) {
    const params = Array.isArray(items) ? { items } : items;
    return this.client.request('comment_private_candidates', params, { timeoutMs: 20000 });
  }

  async commentPlan(params) {
    await this.#launch();
    return this.client.request('comment_plan', params, { timeoutMs: 60000 });
  }

  async commentReply(params) {
    await this.#launch();
    return this.client.request('comment_reply', params, { timeoutMs: 60000 });
  }

  async commentPrivate(params) {
    await this.#launch();
    return this.client.request('comment_private', params, { timeoutMs: 60000 });
  }

  async commentResult(params) {
    return this.client.request('comment_result', params, { timeoutMs: 20000 });
  }

  async liveListen(params, maxItems = 100) {
    const request = typeof params === 'string' ? { url: params, maxItems } : params;
    await this.#launch();
    return this.client.request('live_listen', request, { timeoutMs: 60000 });
  }

  async livePlan(params) {
    return this.client.request('live_plan', params, { timeoutMs: 20000 });
  }

  async liveReply(params) {
    await this.#launch();
    return this.client.request('live_reply', params, { timeoutMs: 60000 });
  }

  async livePrivate(params) {
    await this.#launch();
    return this.client.request('live_private', params, { timeoutMs: 60000 });
  }

  async liveResult(params) {
    return this.client.request('live_result', params, { timeoutMs: 20000 });
  }

  #pauseForSend() {
    this.running = false;
    this.collectEpoch += 1;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.client.busy) this.client.cancel();
  }

  #resumeAfterSend(operationEpoch, resume) {
    if (!resume || this.closed || this.lifecycleEpoch !== operationEpoch) return;
    this.running = true;
    this.#scheduleCollect(++this.collectEpoch);
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.stop();
    this.currentUrl = null;
    this.closePromise = this.#enqueueLifecycle(async () => {
      let idle = await this.client.waitForIdle(3000);
      if (!idle) {
        this.client.cancel();
        idle = await this.client.waitForIdle(3000);
      }
      if (idle && this.remoteOwned) {
        try { await this.client.request('close', {}, { timeoutMs: 10000 }); } catch (error) { this.onStatus?.({ connected: false, collector: 'close_error', error: error.message }); }
      } else if (!idle) this.onStatus?.({ connected: false, collector: 'close_timeout', error: '侧车操作未能在关闭前退出' });
      this.remoteOwned = false;
      this.launchPromise = null;
      this.onStatus?.({ connected: false, collector: 'closed' });
    }).finally(() => { this.closePromise = null; });
    return this.closePromise;
  }
}

module.exports = { ProbeBridge };
