'use strict';

const assert = require('node:assert/strict');
const { cpSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { ProbeBridge } = require('../src/lib/probe-bridge');

const root = join(__dirname, '..', '..');
const fixture = join(root, 'scripts', 'test-fixtures', 'fake-sidecar.cjs');
const work = mkdtempSync(join(tmpdir(), 'douyin-v4-bridge-lifecycle-'));
const runtime = join(work, 'runtime');
mkdirSync(join(runtime, 'probe'), { recursive: true });
cpSync(fixture, join(runtime, 'probe', 'sidecar.py'));

async function main() {
  const env = { ...process.env, DOUYIN_PROBE_PYTHON: process.execPath, FAKE_SIDECAR_SEND_MODE: 'success' };
  const bridge = new ProbeBridge({ accountDir: join(work, 'account-a'), port: 19321, cwd: runtime, resourcesPath: join(work, 'missing'), env });
  try {
    await bridge.open('https://douyin.com/video/123');
    await bridge.start({}, 'video');
    env.FAKE_SIDECAR_SEND_MODE = 'unknown';
    env.FAKE_SIDECAR_DELAY_MS = '500';
    const send = bridge.sendReply('fixture', 'video', { sendId: 'lifecycle-send', id: 'comment-1', roomId: 'https://www.douyin.com/video/123', authorId: 'fixture-author', authorName: 'fixture-user', text: '多少钱' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    bridge.stop();
    const result = await send;
    assert.equal(result.status, 'unknown');
    assert.equal(bridge.running, false, 'user stop must prevent collector resurrection');
    await bridge.close();
    assert.equal(bridge.closed, true);
    await bridge.open('https://www.douyin.com/video/123');
    await bridge.close();
    console.log('ProbeBridge lifecycle PASS (pause-send / no stale resume / close)');
  } finally {
    await bridge.close();
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
