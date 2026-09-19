import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = join(root, 'scripts', 'test-fixtures', 'fake-sidecar.cjs');
const workDir = mkdtempSync(join(tmpdir(), 'douyin-v4-probe-contract-'));
const require = createRequire(import.meta.url);
const { ProbeClient, ProbeError } = require(join(root, 'desktop', 'src', 'lib', 'probe-client.js'));
const { ProbeBridge } = require(join(root, 'desktop', 'src', 'lib', 'probe-bridge.js'));

function makeClient(accountId, envOverrides = {}) {
  const accountDir = join(workDir, accountId);
  mkdirSync(accountDir, { recursive: true });
  const calls = [];
  const client = new ProbeClient({
    accountDir,
    port: 19000 + accountId.charCodeAt(accountId.length - 1),
    resourcesPath: join(workDir, 'missing-resources'),
    cwd: root,
    env: { ...process.env, ...envOverrides },
    spawnImpl: (_command, args, options) => {
      calls.push({ args: [...args] });
      return spawn(process.execPath, [fixture, ...args], options);
    },
  });
  return { client, accountDir, calls };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ProbeError || error?.code, 'error must preserve sidecar code');
    assert.equal(error.code, code);
    return true;
  });
}

async function withEnv(client, key, value, action) {
  const previous = client.env[key];
  if (value === undefined) delete client.env[key];
  else client.env[key] = value;
  try { return await action(); }
  finally {
    if (previous === undefined) delete client.env[key];
    else client.env[key] = previous;
  }
}

async function main() {
  const a = makeClient('account-a');
  const b = makeClient('account-b');

  const capabilities = await a.client.request('capabilities', {});
  assert.equal(capabilities.protocolVersion, 1);
  const search = await a.client.request('search', { keyword: '暴雨末日' });
  assert.equal(search.videos[0].id, 'video-fixture-1');
  const comments = await a.client.request('collect_comments', { url: 'https://www.douyin.com/video/123' });
  assert.equal(comments.events[0].authorId, 'fixture-author');
  assert.equal(Number.isSafeInteger(comments.events[0].observedAt), true, 'collect_comments observedAt must be an integer timestamp');
  const commentTarget = { id: 'comment-1', roomId: 'https://www.douyin.com/video/123', authorId: 'fixture-author', authorName: 'fixture-user', text: '多少钱' };
  const blocked = await withEnv(a.client, 'FAKE_SIDECAR_SEND_MODE', 'blocked', () => a.client.request('send_comment', { sendId: 'send-blocked', target: commentTarget, text: 'fixture', source: 'video' }));
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.sendId, 'send-blocked');
  const unknown = await withEnv(a.client, 'FAKE_SIDECAR_SEND_MODE', 'unknown', () => a.client.request('send_private', { sendId: 'send-unknown', target: { authorId: 'fixture-author' }, text: 'fixture' }));
  assert.equal(unknown.status, 'unknown');
  await withEnv(a.client, 'FAKE_SIDECAR_MODE', 'offline', () => expectCode(a.client.request('doctor', {}), 'offline'));

  await withEnv(a.client, 'FAKE_SIDECAR_MODE', 'noise', () => expectCode(a.client.request('search', { keyword: 'noise' }), 'SIDECAR_PROTOCOL_ERROR'));
  await withEnv(a.client, 'FAKE_SIDECAR_SEND_MODE', 'exit-no-final', () => expectCode(a.client.request('send_comment', { sendId: 'send-child-exit', target: commentTarget, text: 'fixture', source: 'video' }), 'SIDECAR_NO_FINAL'));
  const timeout = withEnv(a.client, 'FAKE_SIDECAR_SEND_MODE', 'delay', () => {
    a.client.env.FAKE_SIDECAR_DELAY_MS = '500';
    return a.client.request('send_comment', { sendId: 'send-timeout', target: commentTarget, text: 'fixture', source: 'video' }, { timeoutMs: 25 });
  });
  await expectCode(timeout, 'SIDECAR_TIMEOUT');
  assert.equal(a.calls.length, 9, 'timeout/no-final/noise must not auto-retry');

  a.client.env.FAKE_SIDECAR_MODE = 'delay';
  a.client.env.FAKE_SIDECAR_DELAY_MS = '500';
  const busy = a.client.request('search', { keyword: 'busy' }, { timeoutMs: 2_000 });
  await expectCode(a.client.request('collect_comments', {}), 'SIDECAR_BUSY');
  a.client.cancel();
  await expectCode(busy, 'SIDECAR_NO_FINAL');

  const oldRequest = a.client.request('search', { keyword: 'old' }, { timeoutMs: 2_000 });
  a.client.cancel();
  await expectCode(oldRequest, 'SIDECAR_NO_FINAL');
  const switched = await b.client.request('search', { keyword: 'account-b' });
  assert.equal(switched.videos[0].id, 'video-fixture-1');
  assert.notEqual(a.accountDir, b.accountDir, 'accounts must have independent state/profile roots');
  assert.notDeepEqual(a.calls[0].args, b.calls[0].args, 'account switch must pass different scoped CLI paths');

  const bridgeRoot = join(workDir, 'bridge-runtime');
  mkdirSync(join(bridgeRoot, 'probe'), { recursive: true });
  cpSync(fixture, join(bridgeRoot, 'probe', 'sidecar.py'));
  const bridge = new ProbeBridge({
    accountDir: join(workDir, 'bridge-account'),
    port: 19123,
    cwd: bridgeRoot,
    resourcesPath: join(workDir, 'missing-packaged'),
    env: { ...process.env, DOUYIN_PROBE_PYTHON: process.execPath, FAKE_SIDECAR_SEND_MODE: 'exit-no-final' },
  });
  try {
    await bridge.open('https://www.douyin.com/video/123');
    await bridge.start({}, 'video');
    const send = await bridge.sendReply('fixture reply', 'video', { sendId: 'bridge-send-unknown', id: 'comment-1', roomId: 'https://www.douyin.com/video/123', authorId: 'fixture-author', authorName: 'fixture-user', text: '多少钱' });
    assert.equal(send.status, 'unknown', 'ProbeBridge must map child exit without final to send unknown');
    assert.equal(send.sendId, 'bridge-send-unknown');
  } finally {
    bridge.close();
  }

  console.log('Probe sidecar integration PASS');
}

try {
  await main();
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
