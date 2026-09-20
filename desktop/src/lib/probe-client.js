'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const METHODS = new Set(['capabilities', 'launch', 'doctor', 'open', 'search', 'collect_comments', 'collect_live', 'send_private', 'send_comment', 'comment_private_candidates', 'live_listen', 'live_plan', 'live_reply', 'live_private', 'live_result', 'close']);
const MAX_LINE = 1024 * 1024;
function requireText(value, name, max = 2000) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ProbeError(`${name} 参数无效`, 'SIDECAR_INVALID_PARAMS'); return value.trim(); }
function requireUrl(value) { const url = new URL(requireText(value, 'url', 2048)); const allowedHosts = new Set(['douyin.com', 'www.douyin.com', 'live.douyin.com', 'v.douyin.com']); if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.username || url.password) throw new ProbeError('侧车目标 URL 无效或暂不支持该抖音域名', 'SIDECAR_INVALID_PARAMS'); if (url.hostname === 'douyin.com') url.hostname = 'www.douyin.com'; return url.href; }
function integer(value, name, min, max) { if (!Number.isInteger(value) || value < min || value > max) throw new ProbeError(`${name} 参数无效`, 'SIDECAR_INVALID_PARAMS'); return value; }
function identifier(value, name, max = 240, required = true) { if (!required && (value == null || value === '')) return ''; const text = requireText(value, name, max); if (!/^[a-zA-Z0-9._:-]+$/.test(text)) throw new ProbeError(`${name} 参数无效`, 'SIDECAR_INVALID_PARAMS'); return text; }
function allowedKeys(value, keys, name = 'params') { for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ProbeError(`${name}.${key} 参数不受支持`, 'SIDECAR_INVALID_PARAMS'); }
function textArray(value, name, maxItems = 100, itemMax = 120) { if (!Array.isArray(value) || value.length > maxItems) throw new ProbeError(`${name} 参数无效`, 'SIDECAR_INVALID_PARAMS'); return value.map((item, index) => requireText(item, `${name}[${index}]`, itemMax)); }
function batchItems(value, name = 'items') {
  if (!Array.isArray(value) || value.length > 500) throw new ProbeError(`${name} 参数无效`, 'SIDECAR_INVALID_PARAMS');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ProbeError(`${name}[${index}] 参数无效`, 'SIDECAR_INVALID_PARAMS');
    allowedKeys(item, ['eventId', 'sendId', 'text'], `${name}[${index}]`);
    const result = { eventId: identifier(item.eventId, `${name}[${index}].eventId`), sendId: identifier(item.sendId, `${name}[${index}].sendId`, 160) };
    if (item.text != null && item.text !== '') result.text = requireText(item.text, `${name}[${index}].text`, 1000);
    return result;
  });
}
function validateParams(method, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new ProbeError('侧车参数必须是对象', 'SIDECAR_INVALID_PARAMS');
  if (method === 'open') return { url: requireUrl(params.url) };
  if (method === 'search') {
    const result = { keyword: requireText(params.keyword, 'keyword', 200), maxVideos: integer(params.maxVideos ?? 20, 'maxVideos', 1, 100), scrollRounds: integer(params.scrollRounds ?? 2, 'scrollRounds', 0, 30), minRelevance: integer(params.minRelevance ?? 0, 'minRelevance', 0, 100) };
    if (params.cursor != null && params.cursor !== '') result.cursor = requireText(params.cursor, 'cursor', 400000);
    return result;
  }
  if (method === 'collect_comments') return { url: requireUrl(params.url), maxItems: integer(params.maxItems ?? 100, 'maxItems', 1, 500), scrollRounds: integer(params.scrollRounds ?? 0, 'scrollRounds', 0, 40) };
  if (method === 'collect_live') return { url: requireUrl(params.url), maxItems: integer(params.maxItems ?? 100, 'maxItems', 1, 500) };
  if (method === 'send_private' || method === 'send_comment') {
    allowedKeys(params, method === 'send_private' ? ['sendId', 'publicSendId', 'target', 'text'] : ['sendId', 'target', 'text', 'source']);
    const sendId = requireText(params.sendId, 'sendId', 160);
    if (!/^[a-zA-Z0-9._:-]+$/.test(sendId)) throw new ProbeError('sendId 参数无效', 'SIDECAR_INVALID_PARAMS');
    if (!params.target || typeof params.target !== 'object' || Array.isArray(params.target)) throw new ProbeError('发送目标缺失', 'SIDECAR_INVALID_PARAMS');
    allowedKeys(params.target, ['id', 'roomId', 'authorId', 'authorName', 'text'], 'target');
    const target = { id: params.target.id ? requireText(params.target.id, 'target.id', 240) : '', roomId: params.target.roomId ? requireUrl(params.target.roomId) : undefined, authorId: params.target.authorId ? requireText(params.target.authorId, 'target.authorId', 240) : '', authorName: params.target.authorName ? requireText(params.target.authorName, 'target.authorName', 120) : '' };
    if (method === 'send_private' && !target.authorId) throw new ProbeError('私信目标缺少 authorId', 'SIDECAR_INVALID_PARAMS');
    if (params.target.text) target.text = requireText(params.target.text, 'target.text', 1000);
    if (method === 'send_comment' && !target.text) throw new ProbeError('评论目标原文缺失', 'SIDECAR_INVALID_PARAMS');
    const result = { sendId, target, text: requireText(params.text, 'text', 1000) };
    if (method === 'send_private' && params.publicSendId != null) result.publicSendId = identifier(params.publicSendId, 'publicSendId', 160);
    if (method === 'send_comment') { if (!['video', 'live'].includes(params.source)) throw new ProbeError('评论来源无效', 'SIDECAR_INVALID_PARAMS'); result.source = params.source; }
    return result;
  }
  if (method === 'comment_private_candidates') {
    allowedKeys(params, ['items']);
    if (!Array.isArray(params.items) || params.items.length === 0 || params.items.length > 500) throw new ProbeError('items 参数无效', 'SIDECAR_INVALID_PARAMS');
    return { items: params.items.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ProbeError(`items[${index}] 参数无效`, 'SIDECAR_INVALID_PARAMS');
      allowedKeys(item, ['eventId', 'authorId', 'authorName', 'publicSendId'], `items[${index}]`);
      return { eventId: identifier(item.eventId, `items[${index}].eventId`), authorId: item.authorId ? identifier(item.authorId, `items[${index}].authorId`) : '', authorName: item.authorName ? requireText(item.authorName, `items[${index}].authorName`, 120) : '', publicSendId: item.publicSendId ? identifier(item.publicSendId, `items[${index}].publicSendId`, 160) : '' };
    }) };
  }
  if (method === 'live_listen') {
    allowedKeys(params, ['url', 'maxItems']);
    const url = requireUrl(params.url); if (new URL(url).hostname !== 'live.douyin.com') throw new ProbeError('直播监听 URL 必须是 live.douyin.com', 'SIDECAR_INVALID_PARAMS');
    return { url, maxItems: integer(params.maxItems ?? 100, 'maxItems', 1, 500) };
  }
  if (method === 'live_plan') {
    allowedKeys(params, ['maxItems', 'windowSeconds', 'scripts', 'keywords', 'excludeKeywords', 'matchMode', 'replyMode', 'policy']);
    if (params.policy !== undefined) throw new ProbeError('策略必须由授权服务端签发', 'SIDECAR_POLICY_NOT_SERVER_ISSUED');
    const result = { maxItems: integer(params.maxItems ?? 20, 'maxItems', 1, 50), windowSeconds: integer(params.windowSeconds ?? 900, 'windowSeconds', 1, 86400) };
    if (params.replyMode !== undefined) { if (!['composer', 'danmaku'].includes(params.replyMode)) throw new ProbeError('replyMode 参数无效', 'SIDECAR_INVALID_PARAMS'); result.replyMode = params.replyMode; }
    if (params.scripts !== undefined) {
      if (!params.scripts || typeof params.scripts !== 'object' || Array.isArray(params.scripts) || Object.keys(params.scripts).length > 500) throw new ProbeError('scripts 参数无效', 'SIDECAR_INVALID_PARAMS');
      result.scripts = {};
      for (const [eventId, script] of Object.entries(params.scripts)) {
        if (!eventId || eventId.length > 240 || !script || typeof script !== 'object' || Array.isArray(script)) throw new ProbeError('scripts 参数无效', 'SIDECAR_INVALID_PARAMS');
        allowedKeys(script, ['publicText', 'privateText'], `scripts.${eventId}`);
        result.scripts[eventId] = { publicText: requireText(script.publicText, `scripts.${eventId}.publicText`, 1000), privateText: requireText(script.privateText, `scripts.${eventId}.privateText`, 1000) };
      }
    }
    if (params.keywords !== undefined) result.keywords = textArray(params.keywords, 'keywords');
    if (params.excludeKeywords !== undefined) result.excludeKeywords = textArray(params.excludeKeywords, 'excludeKeywords');
    if (params.matchMode !== undefined) { if (!['phrase', 'seg', 'all', 'any'].includes(params.matchMode)) throw new ProbeError('matchMode 参数无效', 'SIDECAR_INVALID_PARAMS'); result.matchMode = params.matchMode; }
    return result;
  }
  if (method === 'live_reply' || method === 'live_private') {
    allowedKeys(params, ['batchId', 'items', 'mode']);
    const result = { batchId: identifier(params.batchId, 'batchId'), items: batchItems(params.items) };
    if (params.mode !== undefined) { if (!['composer', 'danmaku'].includes(params.mode)) throw new ProbeError('mode 参数无效', 'SIDECAR_INVALID_PARAMS'); result.mode = params.mode; }
    return result;
  }
  if (method === 'live_result') { allowedKeys(params, ['batchId']); return { batchId: identifier(params.batchId, 'batchId') }; }
  return {};
}

class ProbeError extends Error {
  constructor(message, code = 'SIDECAR_ERROR', details = null) { super(message); this.name = 'ProbeError'; this.code = code; this.details = details; }
}

class ProbeClient {
  constructor({ accountDir, port, resourcesPath = process.resourcesPath, cwd = process.cwd(), env = process.env, packaged = false, spawnImpl = spawn, onProgress } = {}) {
    if (!accountDir || !Number.isInteger(port) || port < 1024 || port > 65535) throw new TypeError('sidecar accountDir/port is invalid');
    this.accountDir = path.resolve(accountDir);
    this.port = port;
    this.resourcesPath = resourcesPath;
    this.cwd = cwd;
    this.env = env;
    this.packaged = packaged;
    this.spawnImpl = spawnImpl;
    this.onProgress = onProgress;
    this.child = null;
    this.cancelledChild = null;
  }

  async request(method, params = {}, { timeoutMs = 45000 } = {}) {
    if (!METHODS.has(method)) throw new ProbeError('sidecar method is not allowed', 'SIDECAR_METHOD_NOT_ALLOWED');
    if (this.child) throw new ProbeError('sidecar 正在执行另一个操作', 'SIDECAR_BUSY');
    params = validateParams(method, params);
    const requestId = crypto.randomUUID();
    const args = ['--state-dir', path.join(this.accountDir, 'probe'), '--profile-dir', path.join(this.accountDir, 'chrome'), '--port', String(this.port)];
    const executable = this.#command(args);
    let child;
    try { child = this.spawnImpl(executable.command, executable.args, { cwd: this.cwd, env: { ...this.env, PYTHONUNBUFFERED: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (error) { throw new ProbeError('无法启动侧车', 'SIDECAR_START_FAILED', { cause: error.message }); }
    this.child = child;
    return new Promise((resolve, reject) => {
      let settled = false;
      let childExited = false;
      let finalValue;
      let finalError = null;
      let finalSeen = false;
      let buffer = '';
      let stderr = '';
      let totalBytes = 0;
      const settle = () => {
        if (settled || !childExited || (!finalSeen && !finalError)) return;
        settled = true;
        clearTimeout(timer);
        if (finalError) reject(finalError); else resolve(finalValue);
      };
      const finish = (error, value) => {
        if (settled || finalError) return;
        if (error) { finalError = error; try { child.kill(); } catch (killError) { console.warn('[probe-client] child kill failed', killError.message); } }
        else { finalSeen = true; finalValue = value; }
        settle();
      };
      const timer = setTimeout(() => finish(new ProbeError('侧车操作超时，结果不可确认', 'SIDECAR_TIMEOUT')), timeoutMs);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        totalBytes += Buffer.byteLength(chunk, 'utf8');
        if (totalBytes > MAX_LINE * 4) return finish(new ProbeError('侧车总输出超过安全上限', 'SIDECAR_OUTPUT_TOO_LARGE'));
        buffer += chunk;
        if (buffer.length > MAX_LINE * 2) return finish(new ProbeError('侧车输出超过安全上限', 'SIDECAR_OUTPUT_TOO_LARGE'));
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line) continue;
          if (line.length > MAX_LINE) return finish(new ProbeError('侧车单行输出超过安全上限', 'SIDECAR_OUTPUT_TOO_LARGE'));
          let message;
          try { message = JSON.parse(line); } catch (error) { return finish(new ProbeError('侧车返回了不可解析的数据', 'SIDECAR_PROTOCOL_ERROR', { cause: error.message })); }
          if (!message || message.id !== requestId) continue;
          if (message.type === 'progress') { this.onProgress?.(message.data || {}); continue; }
          if (message.ok === true) return finish(null, message.result || {});
          if (message.ok === false || message.type === 'error') return finish(new ProbeError(message.error?.message || '侧车操作失败', message.error?.code || 'SIDECAR_REMOTE_ERROR', message.error));
        }
      });
      child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
      child.on('error', (error) => finish(new ProbeError('无法启动侧车', 'SIDECAR_START_FAILED', { cause: error.message })));
      child.on('close', (code, signal) => {
        childExited = true;
        if (this.child === child) this.child = null;
        if (this.cancelledChild === child) { this.cancelledChild = null; if (finalSeen) finalError = new ProbeError('侧车操作已取消，结果不可确认', 'SIDECAR_CANCELLED', { code, signal }); else finalError = new ProbeError(`侧车未返回最终结果（${signal || code}）`, 'SIDECAR_NO_FINAL', { code, signal, stderr }); }
        else if (!finalSeen && !finalError) finalError = new ProbeError(`侧车未返回最终结果（${signal || code}）`, 'SIDECAR_NO_FINAL', { code, signal, stderr });
        settle();
      });
      child.stdin?.on('error', (error) => finish(new ProbeError('无法写入侧车请求', 'SIDECAR_WRITE_FAILED', { cause: error.message })));
      try { child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`); child.stdin.end(); } catch (error) { finish(new ProbeError('无法写入侧车请求', 'SIDECAR_WRITE_FAILED', { cause: error.message })); }
    });
  }

  get busy() { return Boolean(this.child); }
  async waitForIdle(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (this.child && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    return !this.child;
  }

  cancel() { if (this.child) { this.cancelledChild = this.child; try { this.child.kill(); } catch (error) { console.warn('[probe-client] cancel failed', error.message); } } }
  close() { this.cancel(); }

  #command(args) {
    const packaged = path.join(this.resourcesPath || '', 'probe', process.platform === 'win32' ? 'probe-agent.exe' : 'probe-agent');
    if (fs.existsSync(packaged)) return { command: packaged, args };
    if (this.packaged) throw new ProbeError('安装包缺少 probe-agent.exe', 'SIDECAR_RUNTIME_MISSING');
    const script = path.resolve(this.cwd, 'probe', 'sidecar.py');
    const python = this.env.DOUYIN_PROBE_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
    return { command: python, args: [script, ...args] };
  }
}

module.exports = { ProbeClient, ProbeError, METHODS, validateParams };
