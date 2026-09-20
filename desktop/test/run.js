'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore, checksum } = require('../src/lib/json-store');
const { targetUrl, selectorProfile } = require('../src/lib/validation');
const { ApiClient, ApiError } = require('../src/lib/api-client');
const { TaskEngine } = require('../src/lib/task-engine');
const { WorkflowRuntime, RUN_STATES } = require('../src/lib/workflow-runtime');
const { AuthStore } = require('../src/lib/auth-store');
const { platformScope, accountDataPath, browserPartition, sidecarPort } = require('../src/lib/platform-account');

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

test('platform account selection is persisted per workbench user and derives isolated runtime/browser scopes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-platform-'));
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() };
  const auth = new AuthStore(dir, safeStorage);
  auth.setPlatformAccountId('workbench-a', 'platform-a');
  auth.setPlatformAccountId('workbench-b', 'platform-b');
  assert.equal(auth.getPlatformAccountId('workbench-a'), 'platform-a');
  assert.equal(auth.getPlatformAccountId('workbench-b'), 'platform-b');
  assert.equal(auth.getPlatformAccountId('workbench-c'), null);
  const scopeA = platformScope({ workbenchUserId: 'workbench-a', platformAccountId: 'platform-a' });
  const scopeB = platformScope({ workbenchUserId: 'workbench-a', platformAccountId: 'platform-b' });
  assert.notEqual(scopeA.runtimeAccountId, scopeB.runtimeAccountId);
  assert.notEqual(accountDataPath(dir, 'https://license.example', 'workbench-a', 'platform-a'), accountDataPath(dir, 'https://license.example', 'workbench-a', 'platform-b'));
  assert.notEqual(browserPartition('https://license.example', 'workbench-a', 'platform-a'), browserPartition('https://license.example', 'workbench-a', 'platform-b'));
  assert.notEqual(sidecarPort('https://license.example', 'workbench-a', 'platform-a'), sidecarPort('https://license.example', 'workbench-a', 'platform-b'));
});

testAsync('workflow runtime isolates two platform accounts under one workbench user', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-platform-'));
  const store = new JsonStore(path.join(dir, 'data.json'), { workflowRuns: [] });
  const definition = { workflowId: 'platform-isolation.fixture', version: '1', steps: ['hold'] };
  const make = (platformId) => new WorkflowRuntime({ store, accountId: platformScope({ workbenchUserId: 'workbench-a', platformAccountId: platformId }).runtimeAccountId, modelDecider: async () => ({ workflowId: definition.workflowId, version: definition.version, params: {} }), workflows: [definition], stepExecutor: async () => ({ status: 'wait_human', checkpoint: { platformId } }) });
  const accountA = make('platform-a');
  const accountB = make('platform-b');
  const runA = accountA.startPlan(await accountA.planFromIntent('账号 A')); const runB = accountB.startPlan(await accountB.planFromIntent('账号 B'));
  const [waitingA, waitingB] = await Promise.all([accountA.run(runA.runId), accountB.run(runB.runId)]);
  assert.equal(waitingA.checkpoint.platformId, 'platform-a');
  assert.equal(waitingB.checkpoint.platformId, 'platform-b');
  assert.equal(accountA.snapshot().runs.length, 1);
  assert.equal(accountB.snapshot().runs.length, 1);
  assert.equal(accountA.snapshot().runs[0].accountId, 'workbench-a:platform-a');
  assert.equal(accountB.snapshot().runs[0].accountId, 'workbench-a:platform-b');
});

testAsync('workflow decision is frozen before execution and never called while running', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-workflow-'));
  const store = new JsonStore(path.join(dir, 'data.json'), { tasks: [], events: [], leads: [], logs: [], pending: [], selectorProfile: {}, workflowRuns: [] });
  let modelCalls = 0;
  let stepCalls = 0;
  const runtime = new WorkflowRuntime({
    store,
    accountId: 'account-a',
    modelDecider: async ({ intent, accountId }) => { modelCalls += 1; assert.equal(intent, '整理待处理线索'); assert.equal(accountId, 'account-a'); return { planId: 'server_plan_fixture_1', issuedAt: '2026-09-20T00:00:00.000Z', expiresAt: '2026-09-20T01:00:00.000Z', workflowId: 'fixed.fixture', version: '1', params: { mode: 'manual' } }; },
    workflows: [{ workflowId: 'fixed.fixture', version: '1', steps: ['collect', 'finish'] }],
    stepExecutor: async ({ plan, run, step }) => { stepCalls += 1; assert.equal(run.status, RUN_STATES.RUNNING); assert.equal(plan.params.mode, 'manual'); assert.match(step.stepId, /^(collect|finish)$/); return { status: 'completed' }; }
  });
  const plan = await runtime.planFromIntent('整理待处理线索');
  assert.equal(modelCalls, 1);
  assert.equal(plan.planId, 'server_plan_fixture_1');
  assert.equal(plan.issuedAt, '2026-09-20T00:00:00.000Z');
  assert.equal(plan.expiresAt, '2026-09-20T01:00:00.000Z');
  const created = runtime.startPlan(plan);
  const completed = await runtime.run(created.runId);
  assert.equal(completed.status, RUN_STATES.COMPLETED);
  assert.equal(stepCalls, 2);
  assert.equal(modelCalls, 1);
  assert.deepEqual(runtime.snapshot().runs[0].plan.params, { mode: 'manual' });
});

testAsync('workflow model decision rejects fields outside workflowId/version/params', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-workflow-'));
  const store = new JsonStore(path.join(dir, 'data.json'), { workflowRuns: [] });
  const runtime = new WorkflowRuntime({ store, accountId: 'account-a', modelDecider: async () => ({ workflowId: 'strict.fixture', version: '1', params: {}, steps: ['model-controlled'] }) });
  await assert.rejects(runtime.planFromIntent('模型不能改步骤'), /unsupported fields/);
});

testAsync('workflow short retry exhaustion becomes UNKNOWN and manual resume reuses the frozen plan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-workflow-'));
  const store = new JsonStore(path.join(dir, 'data.json'), { workflowRuns: [] });
  let attempts = 0;
  let modelCalls = 0;
  const delays = [];
  const runtime = new WorkflowRuntime({
    store,
    accountId: 'account-a',
    modelDecider: async () => { modelCalls += 1; return { workflowId: 'recoverable.fixture', version: '1', params: { safe: true } }; },
    workflows: [{ workflowId: 'recoverable.fixture', version: '1', steps: [{ stepId: 'send', retryLimit: 2 }] }],
    reconcileAction: async () => ({ status: 'not_found', safeToRetry: true }),
    sleep: async (delayMs) => { delays.push(delayMs); },
    stepExecutor: async () => { attempts += 1; return attempts <= 3 ? { status: 'retryable', error: { code: 'TEMPORARY' } } : { status: 'completed' }; }
  });
  const created = runtime.startPlan(await runtime.planFromIntent('执行一次固定流程'));
  const unknown = await runtime.run(created.runId);
  assert.equal(unknown.status, RUN_STATES.UNKNOWN);
  assert.equal(unknown.steps[0].attempts, 3);
  assert.deepEqual(delays, [5000, 15000]);
  assert.equal(modelCalls, 1);
  const recovered = await runtime.resumeRun(created.runId);
  assert.equal(recovered.status, RUN_STATES.COMPLETED);
  assert.equal(attempts, 4);
  assert.equal(modelCalls, 1);
});

testAsync('unknown side-effect action requires reconciliation and never blindly resends', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-workflow-'));
  const store = new JsonStore(path.join(dir, 'data.json'), { workflowRuns: [] });
  let sends = 0;
  let reconcileCalls = 0;
  let firstAction = null;
  const runtime = new WorkflowRuntime({
    store,
    accountId: 'account-a',
    modelDecider: async () => ({ workflowId: 'side-effect.fixture', version: '1', params: {} }),
    workflows: [{ workflowId: 'side-effect.fixture', version: '1', steps: [{ stepId: 'send', sideEffect: true, retryLimit: 2 }] }],
    stepExecutor: async ({ action }) => { sends += 1; firstAction ||= action; assert.deepEqual(action, firstAction); return { status: 'retryable', error: { code: 'NETWORK_UNKNOWN' } }; },
    reconcileAction: async ({ action }) => { reconcileCalls += 1; assert.deepEqual(action, firstAction); return { status: 'not_found', safeToRetry: true }; },
    sleep: async () => { throw new Error('side-effect retry must not sleep'); }
  });
  const created = runtime.startPlan(await runtime.planFromIntent('执行副作用步骤'));
  const unknown = await runtime.run(created.runId);
  assert.equal(unknown.status, RUN_STATES.UNKNOWN);
  assert.equal(sends, 1);
  const blocked = new WorkflowRuntime({ store, accountId: 'account-a', workflows: [{ workflowId: 'side-effect.fixture', version: '1', steps: [{ stepId: 'send', sideEffect: true }] }], stepExecutor: async () => ({ status: 'completed' }) });
  await assert.rejects(blocked.resumeRun(created.runId), (error) => error.code === 'RECONCILE_REQUIRED');
  const recovered = await runtime.resumeRun(created.runId);
  assert.equal(recovered.status, RUN_STATES.UNKNOWN);
  assert.equal(reconcileCalls, 1);
  assert.equal(sends, 2);
  await assert.rejects(new WorkflowRuntime({ store: new JsonStore(path.join(dir, 'other.json'), { workflowRuns: [] }), accountId: 'account-b', modelDecider: async () => ({ workflowId: 'side-effect.fixture', version: '1', params: {} }), workflows: [{ workflowId: 'side-effect.fixture', version: '1', steps: ['send'] }], stepExecutor: async () => ({ status: 'unknown' }) }).resumeRun('missing'), /workflow run not found/);
});

testAsync('workflow recovery health gate performs two injected checks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-workflow-'));
  const store = new JsonStore(path.join(dir, 'data.json'), { workflowRuns: [] });
  const attempts = [];
  const runtime = new WorkflowRuntime({
    store,
    accountId: 'account-a',
    modelDecider: async () => ({ workflowId: 'health.fixture', version: '1', params: {} }),
    workflows: [{ workflowId: 'health.fixture', version: '1', steps: ['wait'] }],
    healthCheck: async ({ attempt }) => { attempts.push(attempt); return { ok: true, attempt }; },
    stepExecutor: async () => ({ status: 'wait_human', checkpoint: { reason: 'fixture' } })
  });
  const run = runtime.startPlan(await runtime.planFromIntent('等待健康检查'));
  await runtime.run(run.runId);
  const health = await runtime.checkHealth(run.runId);
  assert.equal(health.checksPassed, 2);
  assert.deepEqual(attempts, [1, 2]);
});

testAsync('workflow account lock blocks same account while another account remains isolated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-workflow-'));
  const store = new JsonStore(path.join(dir, 'data.json'), { workflowRuns: [] });
  const definition = { workflowId: 'isolated.fixture', version: '1', steps: ['wait'] };
  const make = (accountId) => new WorkflowRuntime({ store, accountId, modelDecider: async () => ({ workflowId: definition.workflowId, version: definition.version, params: {} }), workflows: [definition], stepExecutor: async () => ({ status: 'wait_human', checkpoint: { reason: 'fixture' } }) });
  const first = make('account-a');
  const second = make('account-b');
  const firstRun = first.startPlan(await first.planFromIntent('账号 A 流程'));
  assert.throws(() => first.startPlan(first.getRun(firstRun.runId).plan), (error) => error.code === 'ACCOUNT_LOCKED');
  const secondRun = second.startPlan(await second.planFromIntent('账号 B 流程'));
  const [firstWaiting, secondWaiting] = await Promise.all([first.run(firstRun.runId), second.run(secondRun.runId)]);
  assert.equal(firstWaiting.status, RUN_STATES.WAITING_HUMAN);
  assert.equal(secondWaiting.status, RUN_STATES.WAITING_HUMAN);
  assert.equal(secondRun.accountId, 'account-b');
  assert.equal(first.snapshot().runs.length, 1);
  assert.equal(second.snapshot().runs.length, 1);
  assert.equal(first.snapshot().runs[0].accountId, 'account-a');
  assert.equal(second.snapshot().runs[0].accountId, 'account-b');
});

testAsync('workflow wait_human pauses at a checkpoint and resume never asks the model again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-workflow-'));
  const store = new JsonStore(path.join(dir, 'data.json'), { workflowRuns: [] });
  let modelCalls = 0;
  let stepCalls = 0;
  const runtime = new WorkflowRuntime({
    store,
    accountId: 'account-a',
    modelDecider: async () => { modelCalls += 1; return { workflowId: 'human.fixture', version: '1', params: {} }; },
    workflows: [{ workflowId: 'human.fixture', version: '1', steps: ['approval'] }],
    stepExecutor: async () => { stepCalls += 1; return stepCalls === 1 ? { status: 'wait_human', checkpoint: { prompt: '请确认' } } : { status: 'completed' }; }
  });
  const created = runtime.startPlan(await runtime.planFromIntent('等待人工确认'));
  const waiting = await runtime.run(created.runId);
  assert.equal(waiting.status, RUN_STATES.WAITING_HUMAN);
  assert.deepEqual(waiting.checkpoint, { prompt: '请确认' });
  const completed = await runtime.resumeRun(created.runId);
  assert.equal(completed.status, RUN_STATES.COMPLETED);
  assert.equal(modelCalls, 1);
  assert.equal(stepCalls, 2);
});

testAsync('workflow runtime fails closed when no fixed executor is supplied', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-workflow-'));
  const store = new JsonStore(path.join(dir, 'data.json'), { workflowRuns: [] });
  const runtime = new WorkflowRuntime({ store, accountId: 'account-a', modelDecider: async () => ({ workflowId: 'no-executor.fixture', version: '1', params: {} }), workflows: [{ workflowId: 'no-executor.fixture', version: '1', steps: ['execute'] }] });
  const run = runtime.startPlan(await runtime.planFromIntent('不能自动执行'));
  const result = await runtime.run(run.runId);
  assert.equal(result.status, RUN_STATES.FAILED);
  assert.equal(result.lastError.code, 'EXECUTOR_UNAVAILABLE');
});

testAsync('workflow invalidation pauses the old account while preserving new-account isolation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-workflow-'));
  const store = new JsonStore(path.join(dir, 'data.json'), { workflowRuns: [] });
  const definition = { workflowId: 'invalidate.fixture', version: '1', steps: ['hold'] };
  const make = (accountId, stepExecutor) => new WorkflowRuntime({ store, accountId, modelDecider: async () => ({ workflowId: definition.workflowId, version: definition.version, params: {} }), workflows: [definition], stepExecutor });
  let signalStepStarted;
  const stepStarted = new Promise((resolve) => { signalStepStarted = resolve; });
  let releaseStep;
  const oldAccount = make('account-old', async () => { signalStepStarted(); return new Promise((resolve) => { releaseStep = resolve; }); });
  const newAccount = make('account-new', async () => ({ status: 'wait_human', checkpoint: { reason: 'fixture' } }));
  const oldRun = oldAccount.startPlan(await oldAccount.planFromIntent('旧账号任务'));
  const running = oldAccount.run(oldRun.runId);
  await stepStarted;
  oldAccount.invalidate('account_switch');
  releaseStep({ status: 'completed' });
  const paused = await running;
  assert.equal(paused.status, RUN_STATES.PAUSED);
  assert.equal(paused.lastError.code, 'SESSION_INVALIDATED');
  const newRun = newAccount.startPlan(await newAccount.planFromIntent('新账号任务'));
  assert.equal(newAccount.getRun(newRun.runId).status, RUN_STATES.PLANNED);
  assert.equal(oldAccount.snapshot().runs.length, 1);
  assert.equal(newAccount.snapshot().runs.length, 1);
  assert.equal(newAccount.snapshot().runs[0].accountId, 'account-new');
});

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
testAsync('ApiClient platform account endpoints preserve the server account contract', async () => {
  const requests = [];
  const api = new ApiClient({ baseUrl: 'https://license.example', authStore: { getToken: () => null }, fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, json: async () => url.endsWith('/platform-accounts') && options.method === 'GET' ? { accounts: [{ id: 'platform-a', platform: 'douyin', accountRef: 'a', displayName: '主账号', status: 'active' }] } : { id: 'platform-b', platform: 'douyin', accountRef: 'b', displayName: '备用账号', status: 'active' } }; } });
  const listed = await api.platformAccounts('platform-token');
  const created = await api.createPlatformAccount({ platform: 'douyin', accountRef: 'b', displayName: '备用账号' }, 'platform-token');
  assert.equal(listed.accounts[0].id, 'platform-a');
  assert.equal(created.id, 'platform-b');
  assert.equal(requests[0].url, 'https://license.example/v1/platform-accounts');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer platform-token');
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
