'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore, checksum } = require('../src/lib/json-store');
const { targetUrl, selectorProfile } = require('../src/lib/validation');
const { ApiClient, ApiError } = require('../src/lib/api-client');
const { TaskEngine } = require('../src/lib/task-engine');

let passed = 0;
function test(name, fn) { try { fn(); passed += 1; console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; } }
const pendingTests = [];
function testAsync(name, fn) { pendingTests.push((async () => { try { await fn(); passed += 1; console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; } })()); }

test('normalizes bare host and rejects credential-bearing or unsupported target URLs', () => { assert.throws(() => targetUrl('https://u:p@douyin.com/video/1')); assert.throws(() => targetUrl('https://foo.douyin.com/video/1')); assert.equal(targetUrl('https://douyin.com/video/1'), 'https://www.douyin.com/video/1'); assert.equal(targetUrl('https://www.douyin.com/video/1'), 'https://www.douyin.com/video/1'); });
test('allows empty optional selectors and CSS combinators', () => { assert.equal(selectorProfile({ commentNode: '.row > .comment', replyButton: '' }).replyButton, ''); });
test('JsonStore commits only after atomic flush', () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-')); const file = path.join(dir, 'data.json'); const store = new JsonStore(file, { events: [] }); store.set({ events: [{ id: 'one' }] }); const reopened = new JsonStore(file, { events: [] }); assert.equal(reopened.get().events[0].id, 'one'); });
test('JsonStore refuses corrupted or inaccessible data', () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-')); const broken = path.join(dir, 'broken.json'); fs.writeFileSync(broken, '{bad'); assert.throws(() => new JsonStore(broken, {}), /存储损坏/); const parentFile = path.join(dir, 'parent'); fs.writeFileSync(parentFile, 'file'); assert.throws(() => new JsonStore(path.join(parentFile, 'data.json'), { value: 1 }), /目录不可读/); });
test('JsonStore selects the highest valid revision and requires recovery after primary corruption', () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-')); const file = path.join(dir, 'data.json'); fs.writeFileSync(file, '{broken'); for (const revision of [1, 2]) { const value = { revision }; fs.writeFileSync(`${file}.v-${revision}-fixture`, JSON.stringify({ format: 1, revision, checksum: checksum(value), value })); } const store = new JsonStore(file, {}); assert.equal(store.get().revision, 2); assert.equal(store.recoveryRequired, true); });
test('JsonStore never treats a malformed envelope as legacy data', () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-')); const file = path.join(dir, 'data.json'); fs.writeFileSync(file, JSON.stringify({ format: 1, revision: 2, checksum: 'wrong', value: { sendStarted: true } })); assert.throws(() => new JsonStore(file, {}), /存储损坏/); });
test('JsonStore flags a damaged newer version instead of silently rolling back', () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-')); const file = path.join(dir, 'data.json'); const old = { sendStarted: false }; fs.writeFileSync(file, JSON.stringify({ format: 1, revision: 1, checksum: checksum(old), value: old })); fs.writeFileSync(`${file}.v-2-partial`, '{"format":1,"revision":2,"value":{"sendStarted":true}'); const store = new JsonStore(file, {}); assert.equal(store.get().sendStarted, false); assert.equal(store.recoveryRequired, true); });
test('JsonStore rejects a directory containing only damaged versions', () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-')); const file = path.join(dir, 'data.json'); fs.writeFileSync(`${file}.v-1-partial`, '{partial'); assert.throws(() => new JsonStore(file, {}), /存储损坏/); });
test('JsonStore EXDEV fallback is revision based and reopens latest data', () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-')); const file = path.join(dir, 'data.json'); const originalRename = fs.renameSync; try { fs.renameSync = () => { const error = new Error('simulated EFS rename'); error.code = 'EXDEV'; throw error; }; const store = new JsonStore(file, { state: 'initial' }); store.set({ state: 'one' }); store.set({ state: 'two' }); const reopened = new JsonStore(file, {}); assert.equal(reopened.get().state, 'two'); assert.equal(reopened.revision, 2); } finally { fs.renameSync = originalRename; } });
test('JsonStore does not commit memory when disk write fails', () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-')); const file = path.join(dir, 'data.json'); const store = new JsonStore(file, { state: 'initial' }); const originalRename = fs.renameSync; try { fs.renameSync = () => { const error = new Error('simulated disk full'); error.code = 'ENOSPC'; throw error; }; assert.throws(() => store.set({ state: 'failed' }), /disk full/); assert.equal(store.get().state, 'initial'); assert.equal(store.revision, 0); } finally { fs.renameSync = originalRename; } });
test('restarts pause persisted running tasks without an active collector', () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-')); const store = new JsonStore(path.join(dir, 'data.json'), () => ({ tasks: [{ id: 'task-running', status: 'running', generation: 2 }], events: [], leads: [], logs: [], pending: [], selectorProfile: {} })); const authStore = { getLicense: () => null, setLicense: () => {} }; new TaskEngine({ store, api: {}, authStore, browser: { close: () => {} }, selectorProfile: {}, onStateChange: () => {} }); const recovered = store.get(); assert.equal(recovered.tasks[0].status, 'paused'); assert.equal(recovered.tasks[0].generation, 3); assert.equal(recovered.logs.at(-1).detail.reason, 'desktop_restarted_without_active_collector'); });

testAsync('ApiClient rejects successful non-json responses', async () => {
  const fakeAuth = { getToken: () => 'token' };
  const api = new ApiClient({ baseUrl: 'https://license.example', authStore: fakeAuth, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }) });
  await assert.rejects(api.me(), (error) => error instanceof ApiError && error.code === 'PROTOCOL_ERROR');
});
testAsync('ApiClient uses login token for immediate me check without persisting it', async () => {
  let seen;
  const api = new ApiClient({ baseUrl: 'https://license.example', authStore: { getToken: () => null }, fetchImpl: async (_url, options) => { seen = options.headers.Authorization; return { ok: true, status: 200, json: async () => ({ user: { id: 'u1' } }) }; } });
  await api.me('fresh-token');
  assert.equal(seen, 'Bearer fresh-token');
});

testAsync('rule event skips unrelated text before paid evaluation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-'));
  const store = new JsonStore(path.join(dir, 'data.json'), () => ({ tasks: [], events: [], leads: [], logs: [], pending: [], selectorProfile: {} }));
  const authStore = { getLicense: () => null, setLicense: () => {} };
  let evaluateCalls = 0;
  const api = { evaluate: async () => { evaluateCalls += 1; return { matched: true, reply: '欢迎咨询', charged: 0, balance: 4 }; } };
  const browser = { start: () => {}, sendReply: async () => ({ status: 'unknown' }), close: () => {} };
  const engine = new TaskEngine({ store, api, authStore, browser, selectorProfile: { verified: true, replyInput: 'textarea', sendButton: 'button', replyButton: 'button' }, ensureLicense: async () => {}, onStateChange: () => {} });
  engine.setLicense({ user: { id: 'u1', status: 'active', expiresAt: Date.now() + 60_000 }, balance: 4, features: {} });
  engine.saveTask({ url: 'https://www.douyin.com/video/1', source: 'video', keywords: ['价格'], excludeKeywords: [], replyTemplate: '欢迎咨询', mode: 'manual', decisionMode: 'rule', intervalMs: 0, dailyLimit: 2, maxActions: 2, status: 'paused' });
  const task = store.get().tasks[0]; await engine.setTaskStatus(task.id, 'running');
  await engine.ingest([{ id: 'x', fingerprint: 'x', source: 'video', roomId: task.url, authorName: 'A', text: '你好', observedAt: new Date().toISOString() }]);
  assert.equal(evaluateCalls, 0); assert.equal(store.get().events[0].reason, 'local_no_keyword');
});

testAsync('zero-cost matched reply creates lead and pending action', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-'));
  const store = new JsonStore(path.join(dir, 'data.json'), () => ({ tasks: [], events: [], leads: [], logs: [], pending: [], selectorProfile: {} }));
  const authStore = { getLicense: () => null, setLicense: () => {} };
  const api = { evaluate: async () => ({ matched: true, intent: '询价', confidence: 0.9, reason: '命中价格', reply: '欢迎咨询', charged: 0, balance: 4 }) };
  let sentTarget = null;
  const browser = { start: () => {}, sendReply: async (_reply, _source, target) => { sentTarget = target; return { status: 'unknown', reason: 'fixture' }; }, close: () => {} };
  const engine = new TaskEngine({ store, api, authStore, browser, selectorProfile: { verified: true, replyInput: 'textarea', sendButton: 'button', replyButton: 'button' }, ensureLicense: async () => {}, onStateChange: () => {} });
  engine.setLicense({ user: { id: 'u1', status: 'active', expiresAt: Date.now() + 60_000 }, balance: 4, features: {} });
  engine.saveTask({ url: 'https://www.douyin.com/video/1', source: 'video', keywords: ['价格'], excludeKeywords: [], replyTemplate: '欢迎咨询', mode: 'manual', decisionMode: 'rule', intervalMs: 0, dailyLimit: 2, maxActions: 2, status: 'paused' });
  const task = store.get().tasks[0]; await engine.setTaskStatus(task.id, 'running');
  await engine.ingest([{ id: 'comment-platform-1', fingerprint: 'x', source: 'video', roomId: task.url, authorName: 'A', text: '价格多少', observedAt: new Date().toISOString() }]);
  assert.equal(store.get().pending.length, 1); assert.equal(store.get().leads.length, 1); assert.equal(store.get().events[0].charged, 0);
  const result = await engine.confirmAction(store.get().pending[0].actionId); assert.equal(result.status, 'unknown'); assert.equal(sentTarget.id, 'comment-platform-1'); assert.equal(store.get().pending.length, 0); assert.equal(store.get().events[0].status, 'sent_unknown');
});

testAsync('stale evaluation cannot create a pending send after session invalidation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-'));
  const store = new JsonStore(path.join(dir, 'data.json'), () => ({ tasks: [], events: [], leads: [], logs: [], pending: [], selectorProfile: {} }));
  let release;
  const api = { evaluate: async () => new Promise((resolve) => { release = resolve; }) };
  const authStore = { getLicense: () => null, setLicense: () => {} };
  const browser = { start: () => {}, sendReply: async () => ({ status: 'unknown' }), close: () => {} };
  const engine = new TaskEngine({ store, api, authStore, browser, selectorProfile: {}, ensureLicense: async () => {}, onStateChange: () => {} });
  engine.setLicense({ user: { id: 'u1', status: 'active', expiresAt: Date.now() + 60_000 }, balance: 4, features: {} });
  engine.saveTask({ url: 'https://www.douyin.com/video/1', source: 'video', keywords: ['价格'], excludeKeywords: [], replyTemplate: '欢迎咨询', mode: 'manual', decisionMode: 'rule', intervalMs: 0, dailyLimit: 2, maxActions: 2, status: 'paused' });
  const task = store.get().tasks[0]; await engine.setTaskStatus(task.id, 'running');
  const ingest = engine.ingest([{ id: 'comment-epoch', fingerprint: 'epoch', source: 'video', roomId: task.url, authorName: 'A', text: '价格多少', observedAt: new Date().toISOString() }]);
  for (let i = 0; i < 20 && !release; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(typeof release, 'function'); engine.invalidate('account_switch'); release({ matched: true, reply: '不应入队', charged: 0 }); await ingest;
  assert.equal(store.get().pending.length, 0); assert.equal(store.get().events[0].status, 'evaluating');
});

testAsync('rule task with empty keywords cannot start and does not call evaluation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-'));
  const store = new JsonStore(path.join(dir, 'data.json'), () => ({ tasks: [], events: [], leads: [], logs: [], pending: [], selectorProfile: {} }));
  const authStore = { getLicense: () => null, setLicense: () => {} }; let calls = 0;
  const engine = new TaskEngine({ store, api: { evaluate: async () => { calls += 1; return {}; } }, authStore, browser: { start: () => {}, close: () => {} }, selectorProfile: {}, onStateChange: () => {} });
  engine.setLicense({ user: { status: 'active', expiresAt: Date.now() + 60000 }, balance: 10 });
  engine.saveTask({ url: 'https://www.douyin.com/video/1', keywords: [], excludeKeywords: [], replyTemplate: 'x', mode: 'manual', decisionMode: 'rule', maxActions: 2, status: 'paused' });
  const task = store.get().tasks[0]; await assert.rejects(engine.setTaskStatus(task.id, 'running'), /至少需要一个关键词/);
  assert.equal(calls, 0); assert.equal(store.get().tasks[0].status, 'paused');
});

testAsync('explicit recheck evaluates only eligible skipped events and queues without sending', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-')); const store = new JsonStore(path.join(dir, 'data.json'), () => ({ tasks: [], events: [], leads: [], logs: [], pending: [], selectorProfile: {} }));
  const authStore = { getLicense: () => null, setLicense: () => {} }; let calls = 0;
  const api = { evaluate: async (payload) => { calls += 1; assert.deepEqual(payload.rule.keywords, ['价格']); return { matched: true, reply: '欢迎咨询', charged: 0, balance: 10 }; } };
  const engine = new TaskEngine({ store, api, authStore, browser: { close: () => {} }, selectorProfile: {}, onStateChange: () => {}, ensureLicense: async () => {} });
  engine.setLicense({ user: { status: 'active', expiresAt: Date.now() + 60000 }, balance: 10 });
  engine.saveTask({ url: 'https://www.douyin.com/video/1', keywords: ['价格'], excludeKeywords: [], replyTemplate: 'x', mode: 'manual', decisionMode: 'rule', maxActions: 2, status: 'paused' });
  const task = store.get().tasks[0]; store.update((d) => ({ ...d, events: [{ eventKey: 'video:key', id: 'e1', taskId: task.id, source: 'video', roomId: task.url, text: '价格多少', status: 'skipped', reason: 'local_no_keyword' }, { eventKey: 'video:done', id: 'e2', taskId: task.id, source: 'video', roomId: task.url, text: '价格', status: 'skipped', reason: 'local_no_keyword', requestPayload: { old: true } }] }));
  const result = await engine.recheckSkipped(task.id); assert.deepEqual(result, { evaluated: 1, queued: 1, skipped: 0 }); assert.equal(calls, 1); assert.equal(store.get().pending.length, 1); assert.equal(store.get().tasks[0].generationToday, 1);
  const second = await engine.recheckSkipped(task.id); assert.deepEqual(second, { evaluated: 0, queued: 0, skipped: 0 }); assert.equal(calls, 1);
});

testAsync('recheck quota stop preserves partial counts and later retry works after manual limit edit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-')); const store = new JsonStore(path.join(dir, 'data.json'), () => ({ tasks: [], events: [], leads: [], logs: [], pending: [], selectorProfile: {} }));
  const authStore = { getLicense: () => null, setLicense: () => {} }; let calls = 0;
  const engine = new TaskEngine({ store, api: { evaluate: async () => { calls += 1; return { matched: true, reply: '回复', charged: 0, balance: 10 }; } }, authStore, browser: { close: () => {} }, selectorProfile: {}, onStateChange: () => {}, ensureLicense: async () => {} });
  engine.setLicense({ user: { status: 'active', expiresAt: Date.now() + 60000 }, balance: 10 });
  engine.saveTask({ url: 'https://www.douyin.com/video/1', keywords: ['价格'], excludeKeywords: [], replyTemplate: 'x', mode: 'manual', decisionMode: 'rule', dailyLimit: 1, maxActions: 1, status: 'paused' });
  let task = store.get().tasks[0]; store.update((d) => ({ ...d, events: [1, 2].map((n) => ({ eventKey: `video:q${n}`, id: `e${n}`, taskId: task.id, source: 'video', roomId: task.url, text: '价格', status: 'skipped', reason: 'generation_budget_exhausted' })) }));
  const partial = await engine.recheckSkipped(task.id); assert.deepEqual(partial, { evaluated: 1, queued: 1, skipped: 0, stopReason: 'generation_budget_exhausted', message: '当前判定额度已用尽（1/1），请手动编辑任务提高判定上限后再试' }); assert.equal(calls, 1);
  task = store.get().tasks[0]; engine.saveTask({ ...task, maxActions: 2, status: 'paused' }); const resumed = await engine.recheckSkipped(task.id); assert.equal(resumed.queued, 1); assert.equal(resumed.evaluated, 1); assert.equal(calls, 2);
});

testAsync('recheck queue recovers after one authorization refresh rejection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-')); const store = new JsonStore(path.join(dir, 'data.json'), () => ({ tasks: [], events: [], leads: [], logs: [], pending: [], selectorProfile: {} }));
  const authStore = { getLicense: () => null, setLicense: () => {} }; let refreshes = 0; let calls = 0;
  const engine = new TaskEngine({ store, api: { evaluate: async () => { calls += 1; return { matched: false, charged: 0 }; } }, authStore, browser: { close: () => {} }, selectorProfile: {}, onStateChange: () => {}, ensureLicense: async () => { refreshes += 1; if (refreshes === 1) throw new Error('temporary'); } });
  engine.setLicense({ user: { status: 'active', expiresAt: Date.now() + 60000 }, balance: 10 }); engine.saveTask({ url: 'https://www.douyin.com/video/1', keywords: ['价格'], excludeKeywords: [], replyTemplate: 'x', mode: 'manual', decisionMode: 'rule', maxActions: 2, status: 'paused' });
  const task = store.get().tasks[0]; store.update((d) => ({ ...d, events: [{ eventKey: 'video:r', id: 'r', taskId: task.id, source: 'video', roomId: task.url, text: '价格', status: 'skipped', reason: 'local_no_keyword' }] }));
  await assert.rejects(engine.recheckSkipped(task.id), /temporary/); const result = await engine.recheckSkipped(task.id); assert.equal(result.evaluated, 1); assert.equal(calls, 1);
});

testAsync('daily send limit remains independent from maxActions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-')); const store = new JsonStore(path.join(dir, 'data.json'), () => ({ tasks: [], events: [], leads: [], logs: [], pending: [], selectorProfile: {} }));
  const authStore = { getLicense: () => null, setLicense: () => {} }; const browser = { close: () => {}, sendReply: async () => ({ status: 'unknown', reason: 'fixture' }) };
  const engine = new TaskEngine({ store, api: {}, authStore, browser, selectorProfile: {}, onStateChange: () => {}, ensureLicense: async () => {} }); engine.setLicense({ user: { status: 'active', expiresAt: Date.now() + 60000 }, balance: 10 });
  engine.saveTask({ url: 'https://www.douyin.com/video/1', keywords: ['价格'], excludeKeywords: [], replyTemplate: 'x', mode: 'manual', decisionMode: 'rule', dailyLimit: 1, maxActions: 5, status: 'running' }); const task = store.get().tasks[0];
  store.update((d) => ({ ...d, tasks: d.tasks.map((t) => ({ ...t, generation: 1 })), events: [1, 2].map((n) => ({ eventKey: `video:s${n}`, id: `s${n}`, taskId: task.id, source: 'video', roomId: task.url, platformId: `p${n}`, text: '价格', status: 'awaiting_confirmation', actionId: `a${n}` })), pending: [1, 2].map((n) => ({ actionId: `a${n}`, sendId: `send${n}`, eventKey: `video:s${n}`, taskId: task.id, source: 'video', channel: 'comment', reply: 'x' })) }));
  assert.equal((await engine.confirmAction('a1')).status, 'unknown'); await assert.rejects(engine.confirmAction('a2'), /本地发送上限/); assert.equal(store.get().tasks[0].sendAttemptsToday, 1);
});

testAsync('recheck cancels deferred authorization and evaluation contexts', async () => {
  const make = (ensureLicense, evaluate) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-')); const store = new JsonStore(path.join(dir, 'data.json'), () => ({ tasks: [], events: [], leads: [], logs: [], pending: [], selectorProfile: {} }));
    const authStore = { getLicense: () => null, setLicense: () => {} }; const engine = new TaskEngine({ store, api: { evaluate }, authStore, browser: { close: () => {} }, selectorProfile: {}, onStateChange: () => {}, ensureLicense });
    engine.setLicense({ user: { status: 'active', expiresAt: Date.now() + 60000 }, balance: 10 }); engine.saveTask({ url: 'https://www.douyin.com/video/1', keywords: ['价格'], excludeKeywords: [], replyTemplate: 'x', mode: 'manual', decisionMode: 'rule', maxActions: 2, status: 'paused' });
    const task = store.get().tasks[0]; store.update((d) => ({ ...d, events: [{ eventKey: 'video:deferred', id: 'deferred', taskId: task.id, source: 'video', roomId: task.url, text: '价格', status: 'skipped', reason: 'local_no_keyword' }] })); return { engine, store, task };
  };
  let releaseEnsure; let ensureStarted = false; let calls = 0;
  const first = make(() => { ensureStarted = true; return new Promise((resolve) => { releaseEnsure = resolve; }); }, async () => { calls += 1; return { matched: true, reply: '不应生成' }; });
  const firstRun = first.engine.recheckSkipped(first.task.id); while (!ensureStarted) await Promise.resolve(); first.engine.saveTask({ ...first.task, keywords: ['新关键词'], status: 'paused' }); releaseEnsure(); const firstResult = await firstRun;
  assert.equal(firstResult.stopReason, 'context_changed'); assert.equal(calls, 0); assert.equal(first.store.get().pending.length, 0);
  let releaseEvaluate; let evaluateStarted = false;
  const second = make(async () => {}, async () => { evaluateStarted = true; return new Promise((resolve) => { releaseEvaluate = resolve; }); });
  const secondRun = second.engine.recheckSkipped(second.task.id); while (!evaluateStarted) await Promise.resolve(); second.engine.invalidate('account_switch'); releaseEvaluate({ matched: true, reply: '不应入队' }); const secondResult = await secondRun;
  assert.equal(secondResult.stopReason, 'context_changed'); assert.equal(second.store.get().pending.length, 0);
});

Promise.all(pendingTests).then(() => console.log(`\n${passed} desktop tests passed`)).catch(() => { process.exitCode = 1; });
