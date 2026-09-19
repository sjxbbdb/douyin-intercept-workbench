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
  const bridge2Env = { ...process.env, DOUYIN_PROBE_PYTHON: process.execPath, FAKE_SIDECAR_CANCEL_DELAY_MS: '150' };
  const observed = [];
  const bridge2 = new ProbeBridge({ accountDir: join(work, 'account-b'), port: 19322, cwd: runtime, resourcesPath: join(work, 'missing'), env: bridge2Env, onEvents: (events) => observed.push(...events) });
  const busyBridge = new ProbeBridge({ accountDir: join(work, 'account-c'), port: 19323, cwd: runtime, resourcesPath: join(work, 'missing'), env });
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

    await bridge2.open('https://www.douyin.com/video/123');
    bridge2Env.FAKE_SIDECAR_DELAY_MS = '500';
    const oldStart = bridge2.start({}, 'video');
    await new Promise((resolve) => setTimeout(resolve, 40));
    bridge2.stop();
    const restarted = bridge2.start({}, 'video');
    await Promise.all([oldStart, restarted]);
    assert.equal(bridge2.running, true, 'restart must wait for cancelled startup and remain active');

    observed.length = 0;
    bridge2.stop();
    bridge2Env.FAKE_SIDECAR_DELAY_MS = '500';
    const cancelledStart = bridge2.start({}, 'video');
    await new Promise((resolve) => setTimeout(resolve, 40));
    bridge2.stop();
    await cancelledStart;
    assert.equal(bridge2.running, false, 'stop during startup must leave collector stopped');
    assert.equal(observed.length, 0, 'cancelled startup must not inject old events');

    bridge2.stop();
    bridge2Env.FAKE_SIDECAR_DELAY_MS = '100';
    const duplicateA = bridge2.start({}, 'video');
    const duplicateB = bridge2.start({}, 'video');
    assert.strictEqual(duplicateA, duplicateB, 'duplicate start must share one lifecycle operation');
    await duplicateA;

    const opening = bridge2.open('https://www.douyin.com/video/456');
    const startingAfterOpen = bridge2.start({}, 'video');
    await Promise.all([opening, startingAfterOpen]);
    assert.equal(bridge2.isOpenFor('https://www.douyin.com/video/456'), true, 'queued start must run after open');
    assert.equal(bridge2.running, true, 'queued start must not be cancelled by open transition');
    await bridge2.close();

    let busyRequests = 0;
    busyBridge.client.child = { kill() {} };
    busyBridge.client.waitForIdle = async () => false;
    busyBridge.client.cancel = () => {};
    busyBridge.client.request = async () => { busyRequests += 1; throw new Error('request must not be reached'); };
    await assert.rejects(() => busyBridge.open('https://www.douyin.com/video/busy'), (error) => error.code === 'SIDECAR_BUSY');
    assert.equal(busyRequests, 0, 'idle failure must not issue launch/open');
    busyBridge.client.child = null;
    busyBridge.client.waitForIdle = async () => true;
    await busyBridge.close();
  } finally {
    await bridge.close();
    await bridge2.close();
    await busyBridge.close();
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
