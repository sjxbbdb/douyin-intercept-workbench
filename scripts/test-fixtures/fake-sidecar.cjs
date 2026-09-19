#!/usr/bin/env node

const readline = require('node:readline');
const path = require('node:path');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const stateDir = arg('--state-dir');
const profileDir = arg('--profile-dir');
const port = arg('--port');
if (!stateDir || !profileDir || port === undefined) {
  process.stderr.write('fake sidecar requires --state-dir --profile-dir --port\n');
  process.exit(2);
}

let finished = false;
let timer = null;

function finish(code = 0) {
  if (finished) return;
  finished = true;
  if (timer) clearTimeout(timer);
  process.exit(code);
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function finalError(id, code, message = code) {
  output({ id, ok: false, error: { code, message } });
  finish();
}

function finalResult(id, result) {
  output({ id, ok: true, result });
  finish();
}

function handle(request) {
  if (!request || typeof request !== 'object' || typeof request.id !== 'string' || typeof request.method !== 'string') {
    finalError(request?.id || 'unknown', 'invalid_params', 'invalid request');
    return;
  }
  const params = request.params && typeof request.params === 'object' ? request.params : {};
  const mode = (request.method.startsWith('send_') ? process.env.FAKE_SIDECAR_SEND_MODE : null) || process.env.FAKE_SIDECAR_MODE || 'success';
  const sendId = typeof params.sendId === 'string' ? params.sendId : `fixture-${request.id}`;
  const accountId = path.basename(stateDir);

  if (mode === 'noise') {
    process.stdout.write('fixture noise is not JSON\n');
    return;
  }
  if (mode === 'exit-no-final') {
    output({ id: request.id, type: 'progress', data: { phase: 'started' } });
    finish(17);
    return;
  }
  if (mode === 'offline') {
    finalError(request.id, 'offline', 'fixture offline');
    return;
  }
  if (mode === 'error') {
    finalError(request.id, 'platform_error', 'fixture platform error');
    return;
  }

  output({ id: request.id, type: 'progress', data: { phase: 'fixture', accountId } });
  const result = request.method === 'capabilities'
    ? { protocolVersion: 1, methods: ['capabilities', 'launch', 'doctor', 'open', 'search', 'collect_comments', 'collect_live', 'send_private', 'send_comment', 'close'], sendStatuses: ['unknown', 'failed', 'blocked'], capability: { video_capture: { implemented: true, evidence: 'fixture' }, private_reply: { implemented: true, evidence: 'fixture' }, video_reply: { implemented: true, evidence: 'fixture' }, live_capture: { implemented: true, evidence: 'fixture' }, live_reply: { implemented: true, evidence: 'fixture' } }, limits: { per_user: 1, hourly: 20, daily: 50 }, accountScope: accountId }
    : request.method === 'launch'
      ? { status: 'ok', browser: { name: 'fixture', port: Number(port) } }
      : request.method === 'open'
        ? { status: 'ok', url: params.url || 'https://www.douyin.com/video/fixture' }
        : request.method === 'search'
    ? { status: 'ok', videos: [{ id: 'video-fixture-1', url: 'https://www.douyin.com/video/123', title: 'fixture video', author: 'fixture-author' }] }
    : request.method === 'collect_comments'
      ? { status: 'ok', events: [{ id: 'comment-fixture-1', source: 'video', roomId: 'https://www.douyin.com/video/123', authorId: 'fixture-author', authorName: 'fixture-user', text: '多少钱', observedAt: Date.now() }] }
      : request.method === 'collect_live'
        ? { status: 'ok', events: [{ id: 'live-fixture-1', source: 'live', roomId: 'https://live.douyin.com/123', authorId: 'fixture-author', authorName: 'fixture-user', text: '直播互动', observedAt: Date.now() }] }
        : { status: mode === 'blocked' ? 'blocked' : mode === 'unknown' ? 'unknown' : 'failed', reason: `fixture-${mode}`, sendId, evidence: { accountId } };

  const complete = () => {
    if (mode === 'blocked' || mode === 'unknown' || mode === 'failed' || mode === 'success' || request.method === 'search' || request.method === 'collect_comments' || request.method === 'collect_live') {
      finalResult(request.id, result);
    } else {
      finalError(request.id, 'invalid_fixture', `unknown fixture ${mode}`);
    }
  };
  const delayMs = Number(process.env.FAKE_SIDECAR_DELAY_MS || 0);
  if (delayMs > 0) timer = setTimeout(complete, delayMs);
  else complete();
}

process.on('SIGTERM', () => finish(143));
process.on('SIGINT', () => finish(130));

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (finished || !line.trim()) return;
  let request;
  try { request = JSON.parse(line); } catch { finalError('unknown', 'invalid_params', 'request is not JSON'); return; }
  handle(request);
});
