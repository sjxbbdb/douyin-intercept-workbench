'use strict';

const { BrowserWindow } = require('electron');
const { canAutoSend } = require('./selectors');

function isAllowedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'));
  } catch (error) {
    return false;
  }
}

function visible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function collectorScript(profile, source = 'video') {
  return `(() => {
    const profile = ${JSON.stringify(profile)};
    const source = ${JSON.stringify(source)};
    const visible = ${visible.toString()};
    const select = (selector) => { try { return selector ? Array.from(document.querySelectorAll(selector)) : []; } catch (error) { return []; } };
    if (!profile.commentNode) return { status: 'needs_calibration', events: [], matchCount: 0 };
    const canonicalRoom = location.origin + location.pathname;
    const state = window.__douyinInterceptCollector || (window.__douyinInterceptCollector = { queue: [], seen: new Set(), observer: null, key: '' });
    const stateKey = JSON.stringify({ profile, source, canonicalRoom });
    if (state.key !== stateKey) { state.key = stateKey; state.queue = []; state.seen = new Set(); state.observer?.disconnect(); state.observer = null; }
    const first = (root, selector) => { try { return selector && root.matches?.(selector) ? root : selector ? root.querySelector(selector) : null; } catch (error) { return null; } };
    const collect = (node) => {
      if (!visible(node)) return;
      const textNode = profile.commentText ? first(node, profile.commentText) : node;
      const authorNode = profile.commentAuthor ? first(node, profile.commentAuthor) : null;
      const idNode = profile.commentId ? first(node, profile.commentId) : null;
      const text = String(textNode?.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 1000);
      const authorName = String(authorNode?.textContent || '').trim().slice(0, 120);
      const pageId = String(idNode?.getAttribute('data-comment-id') || idNode?.getAttribute('data-id') || idNode?.textContent || '').trim().slice(0, 120);
      if (!text) return;
      const fingerprint = [canonicalRoom, pageId || authorName, text].join('|');
      if (state.seen.has(fingerprint)) return;
      state.seen.add(fingerprint);
      state.queue.push({ id: pageId || '', fingerprint, source, roomId: canonicalRoom, authorId: '', authorName, text, observedAt: new Date().toISOString() });
      if (state.queue.length > 500) state.queue.splice(0, state.queue.length - 500);
      if (state.seen.size > 5000) { const oldest = state.seen.values().next().value; state.seen.delete(oldest); }
    };
    if (!state.observer) {
      state.observer?.disconnect();
      const matching = (node) => { if (!node || node.nodeType !== 1) return []; const found = []; try { if (node.matches(profile.commentNode)) found.push(node); found.push(...node.querySelectorAll(profile.commentNode)); } catch (error) { return []; } return found; };
      state.observer = new MutationObserver((mutations) => { for (const mutation of mutations) { for (const node of mutation.addedNodes) for (const match of matching(node)) collect(match); const target = mutation.target?.nodeType === 3 ? mutation.target.parentElement : mutation.target; for (const match of matching(target)) collect(match); } });
      state.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      for (const node of select(profile.commentNode)) collect(node);
    }
    const events = state.queue.splice(0, 100);
    return { status: 'ready', matchCount: select(profile.commentNode).filter(visible).length, events };
  })()`;
}

function probeScript(profile) {
  return `(() => {
    const profile = ${JSON.stringify(profile)};
    const visible = ${visible.toString()};
    const select = (selector) => { try { return selector ? Array.from(document.querySelectorAll(selector)) : []; } catch (error) { return []; } };
    const count = (selector) => select(selector).filter(visible).length;
    const sample = profile.commentNode ? select(profile.commentNode).filter(visible).slice(0, 3).map(node => String(node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160)) : [];
    return { commentNode: count(profile.commentNode), commentText: count(profile.commentText), commentAuthor: count(profile.commentAuthor), replyInput: count(profile.replyInput), sendButton: count(profile.sendButton), replyButton: count(profile.replyButton), sample, url: location.href };
  })()`;
}

function replyScript(profile, replyText, source, eventTarget) {
  return `(async () => {
    const profile = ${JSON.stringify(profile)};
    const replyText = ${JSON.stringify(replyText)};
    const source = ${JSON.stringify(source)};
    const eventTarget = ${JSON.stringify(eventTarget || {})};
    const canonicalRoom = location.origin + location.pathname;
    const visible = ${visible.toString()};
    const select = (selector) => { try { return selector ? Array.from(document.querySelectorAll(selector)) : []; } catch (error) { return []; } };
    const first = (root, selector) => { try { return selector && root.matches?.(selector) ? root : selector ? root.querySelector(selector) : null; } catch (error) { return null; } };
    const textOf = (root, selector) => String((selector ? first(root, selector) : root)?.textContent || '').trim().replace(/\\s+/g, ' ');
    if (eventTarget.roomId && eventTarget.roomId !== canonicalRoom) return { status: 'blocked', reason: 'target_room_changed' };
    if (!profile.replyInput || !profile.sendButton) return { status: 'blocked', reason: 'reply_selector_unverified' };
    const nodes = select(profile.commentNode).filter(visible).filter((node) => { const text = textOf(node, profile.commentText); const author = textOf(node, profile.commentAuthor); const idNode = profile.commentId ? first(node, profile.commentId) : null; const pageId = String(idNode?.getAttribute('data-comment-id') || idNode?.getAttribute('data-id') || idNode?.textContent || '').trim(); return (!eventTarget.id || pageId === eventTarget.id) && (!eventTarget.text || text === eventTarget.text) && (!eventTarget.authorName || author === eventTarget.authorName); });
    if (source === 'video') {
      if (nodes.length !== 1 || !profile.replyButton) return { status: 'blocked', reason: nodes.length ? 'comment_target_ambiguous' : 'comment_target_not_visible' };
      const replyButton = (() => { try { return Array.from(nodes[0].querySelectorAll(profile.replyButton)).find(visible); } catch (error) { return null; } })();
      if (!replyButton || replyButton.disabled) return { status: 'blocked', reason: 'reply_button_not_visible' };
      replyButton.click();
      await new Promise((resolve) => setTimeout(resolve, 350));
    } else if (source !== 'live') return { status: 'blocked', reason: 'unsupported_source' };
    const editors = select(profile.replyInput).filter(visible);
    const input = source === 'video' ? (editors.find((candidate) => nodes[0]?.contains(candidate)) || (editors.length === 1 ? editors[0] : null)) : (editors.length === 1 ? editors[0] : document.activeElement && visible(document.activeElement) ? document.activeElement : null);
    const buttons = select(profile.sendButton).filter(visible);
    const scopedButtons = source === 'video' && nodes[0] ? Array.from(nodes[0].querySelectorAll(profile.sendButton)).filter(visible) : [];
    const button = source === 'video' ? (scopedButtons.length === 1 ? scopedButtons[0] : buttons.length === 1 ? buttons[0] : null) : buttons.length === 1 ? buttons[0] : null;
    if (!input || !button) return { status: 'blocked', reason: 'reply_control_not_visible' };
    input.focus();
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value')?.set;
      setter?.call(input, replyText);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (input.isContentEditable) {
      input.textContent = replyText;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replyText }));
    }
    const current = input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.value : input.textContent;
    if (String(current || '').trim() !== replyText.trim() || button.disabled) return { status: 'blocked', reason: 'reply_input_verification_failed' };
    button.click();
    return { status: 'unknown', source, channel: source === 'live' ? 'public_live_room' : 'video_comment_reply', reason: 'visible_dom_action_without_platform_response' };
  })()`;
}

class BrowserBridge {
  constructor({ parentWindow, onStatus, onEvents, getPartition }) {
    this.parentWindow = parentWindow;
    this.onStatus = onStatus;
    this.onEvents = onEvents;
    this.getPartition = getPartition;
    this.window = null;
    this.profile = null;
    this.source = 'video';
    this.pollTimer = null;
  }

  async open(url) {
    if (!isAllowedUrl(url)) throw new Error('目标地址必须是 https://douyin.com 或其子域名');
    if (this.window && !this.window.isDestroyed()) { if (this.pollTimer) clearInterval(this.pollTimer); this.pollTimer = null; this.profile = null; await this.window.loadURL(url); const finalUrl = this.window.webContents.getURL(); this.onStatus?.({ connected: true, url: finalUrl }); return finalUrl; }
    this.window = new BrowserWindow({ width: 1240, height: 860, parent: this.parentWindow, title: '抖音专用工作窗口', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false, partition: this.getPartition?.() || 'persist:douyin-guest' } });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, nextUrl) => { if (!isAllowedUrl(nextUrl)) event.preventDefault(); });
    this.window.webContents.on('did-start-navigation', () => this.onStatus?.({ navigating: true }));
    this.window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    this.window.on('closed', () => this.close());
    await this.window.loadURL(url);
    const finalUrl = this.window.webContents.getURL();
    this.onStatus?.({ connected: true, url: finalUrl });
    return finalUrl;
  }

  async search() { throw new Error('Electron 回退窗口不支持搜索任务，请使用专用 Chrome 侧车'); }

  async probe(profile) {
    if (!this.window || this.window.isDestroyed()) throw new Error('请先打开目标抖音页面');
    return this.window.webContents.executeJavaScript(probeScript(profile), true);
  }

  isOpenFor(url) {
    try { const expected = new URL(url); const actual = new URL(this.window?.webContents?.getURL?.() || ''); return expected.hostname === actual.hostname && expected.pathname === actual.pathname; } catch (error) { return false; }
  }

  start(profile, source = 'video') {
    this.profile = profile;
    this.source = source;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => { void this.poll(); }, 1000);
    void this.poll();
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.profile = null;
  }

  async poll() {
    if (!this.window || this.window.isDestroyed() || !this.profile) return;
    try {
      const result = await this.window.webContents.executeJavaScript(collectorScript(this.profile, this.source), true);
      if (!result || typeof result !== 'object' || !Array.isArray(result.events) || typeof result.status !== 'string') throw new Error('collector returned invalid data');
      this.onStatus?.({ connected: true, collector: result.status, matchCount: Number(result.matchCount) || 0 });
      if (result.events.length) this.onEvents?.(result.events);
    } catch (error) { this.onStatus?.({ connected: false, collector: 'error', error: error.message }); }
  }

  async sendReply(replyText, source, eventTarget) {
    if (!this.window || this.window.isDestroyed()) return { status: 'blocked', reason: 'browser_not_open' };
    if (!canAutoSend(this.profile, source)) return { status: 'blocked', reason: 'reply_selector_unverified' };
    const result = await this.window.webContents.executeJavaScript(replyScript(this.profile, replyText, source, eventTarget), true);
    if (!result || typeof result !== 'object' || typeof result.status !== 'string') throw new Error('reply action returned invalid data');
    return result;
  }

  canSend(source = this.source) { return source !== 'private' && canAutoSend(this.profile, source); }

  async sendPrivate() { return { status: 'blocked', reason: 'private_requires_sidecar' }; }

  close() {
    this.stop();
    const current = this.window;
    this.window = null;
    if (current && !current.isDestroyed()) current.destroy();
    this.onStatus?.({ connected: false, collector: 'closed' });
  }
}

module.exports = { BrowserBridge, isAllowedUrl, collectorScript, probeScript, replyScript };
