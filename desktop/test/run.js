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
const { createWorkflowAdapter } = require('../src/lib/workflow-adapter');
const { platformWorkflowDefinitions } = require('../src/lib/workflow-contracts');
const { AuthStore } = require('../src/lib/auth-store');
const { platformScope, accountDataPath, browserPartition, sidecarPort } = require('../src/lib/platform-account');
const { AccountRuntimeManager } = require('../src/lib/account-runtime-manager');

let passed = 0;
function test(name, fn) { try { fn(); passed += 1; console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; } }
const pendingTests = [];
function testAsync(name, fn) { pendingTests.push((async () => { try { await fn(); passed += 1; console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name}`); throw error; } })()); }

test('normalizes bare host and rejects credential-bearing or unsupported target URLs', () => { assert.throws(() => targetUrl('https://u:p@douyin.com/video/1')); assert.throws(() => targetUrl('https://foo.douyin.com/video/1')); assert.equal(targetUrl('https://douyin.com/video/1'), 'https://www.douyin.com/video/1'); assert.equal(targetUrl('https://www.douyin.com/video/1'), 'https://www.douyin.com/video/1'); });
test('allows empty optional selectors and CSS combinators', () => { assert.equal(selectorProfile({ commentNode: '.row > .comment', replyButton: '' }).replyButton, ''); });
testAsync('platform workflow adapter forwards search paging and keeps unverified sends fail-closed', async () => {
  const calls = [];
  const browser = {
    search: async (params) => { calls.push({ type: 'search', params }); return { status: 'ok', videos: [{ url: 'https://www.douyin.com/video/1' }], cursor: 'next', hasMore: true }; },
    canSend: () => false,
    sendReply: async () => { calls.push({ type: 'send' }); return { status: 'sent_confirmed' }; }
  };
  const adapter = createWorkflowAdapter({ browser });
  const search = await adapter.execute({ run: { runId: 'search-1', workflowId: 'video.search' }, plan: { params: { keyword: '暴雨末日', maxVideos: 10, cursor: 'cursor-1', minRelevance: 70 } }, step: { stepId: 'search' } });
  assert.equal(search.status, 'completed');
  assert.deepEqual(search.result.poolIds, undefined);
  assert.deepEqual(search.checkpoint, { phase: 'search', status: 'ok', count: 1, cursor: 'next', hasMore: true });
  assert.deepEqual(calls[0], { type: 'search', params: { keyword: '暴雨末日', maxVideos: 10, scrollRounds: 2, cursor: 'cursor-1', page: undefined, minRelevance: 70, strict: false } });
  const blocked = await adapter.execute({ run: { runId: 'comment-1', workflowId: 'comment.reply_then_private' }, plan: { params: { target: { id: 'c1', roomId: 'https://www.douyin.com/video/1', authorId: 'u1', text: '多少钱' }, publicReply: '请问您想了解哪个型号？' } }, step: { stepId: 'reply_comment' } });
  assert.equal(blocked.status, 'wait_human');
  assert.equal(calls.filter((item) => item.type === 'send').length, 0);
  const mismatch = await adapter.execute({ run: { runId: 'comment-mismatch', workflowId: 'comment.reply_then_private' }, plan: { params: { keywords: ['价格'], target: { id: 'c2', roomId: 'https://www.douyin.com/video/1', authorId: 'u2', text: '天气不错' }, publicReply: '不应发送' } }, step: { stepId: 'reply_comment' } });
  assert.equal(mismatch.error.code, 'TARGET_KEYWORD_MISMATCH');
  const publicOnly = createWorkflowAdapter({ browser: { canSend: () => true, sendReply: async () => { calls.push({ type: 'public-fallback' }); return { status: 'sent_confirmed' }; } } });
  const privateBlocked = await publicOnly.execute({ run: { runId: 'private-missing', workflowId: 'comment.reply_then_private' }, plan: { params: { target: { id: 'c3', roomId: 'https://www.douyin.com/video/1', authorId: 'u3', text: '价格' }, keywords: ['价格'], privateReply: '不应公开发送' } }, step: { stepId: 'private_message' }, action: { actionId: 'a-private-missing', idempotencyKey: 'idem-private-missing' } });
  assert.equal(privateBlocked.error.code, 'PUBLIC_DELIVERY_ID_MISSING');
  assert.equal(calls.filter((item) => item.type === 'public-fallback').length, 0);
});
testAsync('platform workflow adapter preserves terminal search evidence for human recovery', async () => {
  const browser = {
    search: async () => ({
      status: 'captcha',
      videos: [{ id: 'v1', url: 'https://www.douyin.com/video/1', title: '候选', author: '作者', relevance: { score: 80 } }],
      cursor: null,
      hasMore: false,
      stoppedReason: 'captcha',
      poolIds: ['v1', 'v2', 'v1'],
      poolSize: 2,
      page: 3,
      skippedSeen: 1,
      platformHasMore: true,
      platformCursor: 'telemetry-only',
      filter: { collected: 2, returned: 1, filteredByRelevance: 1, minRelevance: 70 }
    })
  };
  const adapter = createWorkflowAdapter({ browser });
  const result = await adapter.execute({ run: { runId: 'search-captcha', workflowId: 'video.search' }, plan: { params: { keyword: '暴雨末日' } }, step: { stepId: 'search' } });
  assert.equal(result.status, 'wait_human');
  assert.deepEqual(result.result, {
    kind: 'video_search',
    videos: [{ id: 'v1', url: 'https://www.douyin.com/video/1', title: '候选', author: '作者', relevance: 80 }],
    cursor: null,
    hasMore: false,
    poolIds: ['v1', 'v2'],
    poolSize: 2,
    page: 3,
    skippedSeen: 1,
    stoppedReason: 'captcha',
    platformHasMore: true,
    platformCursor: 'telemetry-only',
    filter: { collected: 2, returned: 1, filteredByRelevance: 1, minRelevance: 70 }
  });
  assert.deepEqual(result.checkpoint, {
    phase: 'search', status: 'captcha', count: 1, cursor: null, hasMore: false,
    stoppedReason: 'captcha', poolIds: ['v1', 'v2'], poolSize: 2, page: 3,
    skippedSeen: 1, platformHasMore: true, platformCursor: 'telemetry-only',
    filter: { collected: 2, returned: 1, filteredByRelevance: 1, minRelevance: 70 }
  });
});
testAsync('platform workflow adapter exposes only explicit confirmed delivery', async () => {
  const browser = { canSend: () => true, isOpenFor: () => true, sendReply: async () => ({ status: 'sent_confirmed', sendId: 's1' }), sendPrivate: async () => ({ status: 'sent_confirmed', sendId: 's2' }) };
  const adapter = createWorkflowAdapter({ browser });
  const run = { runId: 'comment-2', workflowId: 'comment.reply_then_private' };
  const plan = { params: { keywords: ['多少钱'], target: { id: 'c1', roomId: 'https://www.douyin.com/video/1', authorId: 'u1', authorName: '小王', text: '多少钱' }, publicReply: '公开回复', privateReply: '私信回复' } };
  const publicResult = await adapter.execute({ run, plan, step: { stepId: 'reply_comment' }, action: { actionId: 'a-public', idempotencyKey: 'idem-public' } });
  assert.deepEqual(publicResult.result, { deliveryStatus: 'sent_confirmed', reason: null, sendId: 's1' });
  const privateResult = await adapter.execute({ run, plan, step: { stepId: 'private_message' }, action: { actionId: 'a-private', idempotencyKey: 'idem-private' } });
  assert.deepEqual(privateResult.result, { deliveryStatus: 'sent_confirmed', reason: null, sendId: 's2' });
  const unknownAdapter = createWorkflowAdapter({ browser: { canSend: () => true, sendReply: async () => ({ status: 'unknown', sendId: 's-unknown' }), sendPrivate: async () => { throw new Error('private send must be gated'); } } });
  const unknownRun = { runId: 'comment-unknown-public', workflowId: 'comment.reply_then_private' };
  const unknownPublic = await unknownAdapter.execute({ run: unknownRun, plan, step: { stepId: 'reply_comment' }, action: { actionId: 'a-public-unknown', idempotencyKey: 'idem-public-unknown' } });
  assert.equal(unknownPublic.status, 'unknown');
  const unknownPrivate = await unknownAdapter.execute({ run: unknownRun, plan, step: { stepId: 'private_message' }, action: { actionId: 'a-private-unknown', idempotencyKey: 'idem-private-unknown' } });
  assert.equal(unknownPrivate.error.code, 'PUBLIC_DELIVERY_NOT_CONFIRMED');
});
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

testAsync('account runtime manager serializes one account and runs different accounts in parallel', async () => {
  const contexts = [];
  const starts = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const manager = new AccountRuntimeManager({
    contextFactory: async ({ accountId }) => { const context = { accountId, created: contexts.length + 1 }; contexts.push(context); return context; }
  });
  manager.register('douyin-a', { profile: 'a' });
  manager.register('douyin-b', { profile: 'b' });
  const first = manager.run('douyin-a', async ({ accountId, context }) => { starts.push(`${accountId}:first`); await firstGate; return context.created; }, { taskId: 'a-first' });
  const second = manager.run('douyin-a', async ({ accountId }) => { starts.push(`${accountId}:second`); return 'second'; }, { taskId: 'a-second' });
  const parallel = manager.run('douyin-b', async ({ accountId, context }) => { starts.push(`${accountId}:first`); return context.created; }, { taskId: 'b-first' });
  for (let attempt = 0; attempt < 20 && !starts.includes('douyin-b:first'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(starts, ['douyin-a:first', 'douyin-b:first']);
  assert.equal(manager.snapshot().accounts.find((account) => account.accountId === 'douyin-a').queued, 1);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second, parallel]), [1, 'second', 2]);
  assert.deepEqual(starts, ['douyin-a:first', 'douyin-b:first', 'douyin-a:second']);
  assert.equal(contexts.length, 2);
});

testAsync('account runtime manager deduplicates task keys and invalidates only one account', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const manager = new AccountRuntimeManager({ contextFactory: async ({ accountId }) => ({ accountId }) });
  const first = manager.run('douyin-a', async ({ signal }) => { await gate; return signal.aborted ? 'aborted' : 'completed'; }, { idempotencyKey: 'same-task' });
  const duplicate = manager.run('douyin-a', async () => 'must-not-run', { idempotencyKey: 'same-task' });
  assert.strictEqual(duplicate, first);
  const other = manager.run('douyin-b', async ({ accountId }) => accountId, { idempotencyKey: 'other-task' });
  assert.equal(await other, 'douyin-b');
  assert.equal(manager.invalidate('douyin-a', '切换账号'), true);
  await assert.rejects(first, (error) => error.code === 'ACCOUNT_INVALIDATED');
  assert.equal(manager.snapshot().accounts.find((account) => account.accountId === 'douyin-a').status, 'invalidated');
  release();
  assert.equal(manager.snapshot().accounts.find((account) => account.accountId === 'douyin-b').status, 'active');
});

testAsync('account runtime manager closes created contexts and rejects new work', async () => {
  let closeCalls = 0;
  const manager = new AccountRuntimeManager({ contextFactory: async () => ({ close: async () => { closeCalls += 1; } }) });
  await manager.getContext('douyin-a');
  const snapshot = await manager.close();
  assert.equal(closeCalls, 1);
  assert.equal(snapshot.closed, true);
  assert.equal(snapshot.accounts[0].status, 'closed');
  assert.throws(() => manager.run('douyin-b', async () => {}), (error) => error.code === 'MANAGER_CLOSED');
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

test('platform workflow contracts keep public reply before private follow-up', () => {
  const contracts = platformWorkflowDefinitions();
  const comment = contracts.find((item) => item.workflowId === 'comment.reply_then_private');
  const live = contracts.find((item) => item.workflowId === 'live.reply_then_private');
  assert.deepEqual(comment.steps.map((step) => step.stepId), ['reply_comment', 'private_message']);
  assert.deepEqual(live.steps.map((step) => step.stepId), ['reply_public', 'private_message']);
  for (const definition of [comment, live]) {
    assert.deepEqual(definition.steps[0].successStatuses, ['sent_confirmed']);
    assert.deepEqual(definition.steps[1].requiresPrevious.resultStatuses, ['sent_confirmed']);
    assert.equal(definition.steps[1].requiresPrevious.stepId, definition.steps[0].stepId);
  }
  // A caller cannot mutate the process-wide definitions through the returned copy.
  comment.steps[0].stepId = 'tampered';
  assert.equal(platformWorkflowDefinitions().find((item) => item.workflowId === comment.workflowId).steps[0].stepId, 'reply_comment');
});

testAsync('comment workflow blocks private message when public delivery is unknown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-comment-gate-'));
  const store = new JsonStore(path.join(dir, 'data.json'), { workflowRuns: [] });
  const definition = platformWorkflowDefinitions().find((item) => item.workflowId === 'comment.reply_then_private');
  const calls = [];
  const runtime = new WorkflowRuntime({
    store,
    accountId: 'account-a',
    modelDecider: async () => ({ workflowId: definition.workflowId, version: definition.version, params: {} }),
    workflows: [definition],
    stepExecutor: async ({ step }) => {
      calls.push(step.stepId);
      return { status: 'completed', result: { deliveryStatus: 'sent_unknown', evidence: { source: 'fixture' } } };
    }
  });
  const run = runtime.startPlan(await runtime.planFromIntent('评论命中后先公开回复，再私信'));
  const result = await runtime.run(run.runId);
  assert.equal(result.status, RUN_STATES.UNKNOWN);
  assert.deepEqual(calls, ['reply_comment']);
  assert.equal(result.steps[0].resultStatus, 'sent_unknown');
  assert.throws(() => runtime.applyResultDecision(run.runId, 'retry'), (error) => error.code === 'RESULT_REQUIRES_RECONCILIATION');
  const waiting = runtime.applyResultDecision(run.runId, 'wait_human', { reason: '请核对公开回复是否已送达' });
  assert.equal(waiting.action, 'wait_human');
  assert.equal(waiting.run.status, RUN_STATES.WAITING_HUMAN);
  assert.deepEqual(calls, ['reply_comment']);
});

testAsync('live workflow executes private follow-up only after confirmed public delivery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-live-gate-'));
  const store = new JsonStore(path.join(dir, 'data.json'), { workflowRuns: [] });
  const definition = platformWorkflowDefinitions().find((item) => item.workflowId === 'live.reply_then_private');
  const calls = [];
  const runtime = new WorkflowRuntime({
    store,
    accountId: 'account-live',
    modelDecider: async () => ({ workflowId: definition.workflowId, version: definition.version, params: { roomId: 'fixture-room' } }),
    workflows: [definition],
    stepExecutor: async ({ step }) => {
      calls.push(step.stepId);
      return { status: 'completed', result: { deliveryStatus: 'sent_confirmed', evidence: { source: 'fixture-only' } } };
    }
  });
  const run = runtime.startPlan(await runtime.planFromIntent('直播间命中后公屏回复再私信'));
  const result = await runtime.run(run.runId);
  assert.equal(result.status, RUN_STATES.COMPLETED);
  assert.deepEqual(calls, ['reply_public', 'private_message']);
  assert.equal(result.steps[0].resultStatus, 'sent_confirmed');
  assert.equal(result.steps[1].resultStatus, 'sent_confirmed');
});

testAsync('known failed result can be retried by decision while unknown cannot be blindly retried', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-result-transition-'));
  const store = new JsonStore(path.join(dir, 'data.json'), { workflowRuns: [] });
  const definition = { workflowId: 'retry.fixture', version: '1', steps: [{ stepId: 'safe', retryLimit: 0 }] };
  let attempts = 0;
  const runtime = new WorkflowRuntime({
    store,
    accountId: 'account-a',
    workflows: [definition],
    stepExecutor: async () => { attempts += 1; return attempts === 1 ? { status: 'failed', error: { code: 'KNOWN_FAILURE' } } : { status: 'completed' }; }
  });
  const run = runtime.startPlan({ workflowId: definition.workflowId, version: definition.version, params: {} });
  const failed = await runtime.run(run.runId);
  assert.equal(failed.status, RUN_STATES.FAILED);
  const retry = runtime.applyResultDecision(run.runId, 'retry');
  assert.equal(retry.action, 'run');
  const completed = await runtime.run(run.runId);
  assert.equal(completed.status, RUN_STATES.COMPLETED);
  assert.equal(attempts, 2);
  const stopped = runtime.applyResultDecision(run.runId, 'complete');
  assert.equal(stopped.action, 'complete');
  assert.equal(stopped.run.status, RUN_STATES.COMPLETED);
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

testAsync('workflow result decision is post-run only and validates the four decisions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-agent-result-decision-'));
  const store = new JsonStore(path.join(dir, 'data.json'), { workflowRuns: [] }); let calls = 0; let releaseStep; const gate = new Promise((resolve) => { releaseStep = resolve; });
  const runtime = new WorkflowRuntime({ store, accountId: 'decision-account', modelDecider: async () => ({ workflowId: 'decision.fixture', version: '1', params: {} }), resultDecider: async ({ status }) => { calls += 1; assert.equal(status, RUN_STATES.FAILED); return { decision: 'retry' }; }, workflows: [{ workflowId: 'decision.fixture', version: '1', steps: ['step'] }], stepExecutor: async () => { await gate; return { status: 'failed', error: { code: 'fixture' } }; } });
  const run = runtime.startPlan(await runtime.planFromIntent('结果决策')); const running = runtime.run(run.runId); for (let i = 0; i < 20 && runtime.getRun(run.runId).status !== RUN_STATES.RUNNING; i += 1) await new Promise((resolve) => setTimeout(resolve, 1)); await assert.rejects(runtime.decideResult(run.runId), /RUNNING/); releaseStep(); await running;
  assert.deepEqual(await runtime.decideResult(run.runId, { summary: 'fixture' }), { decision: 'retry' }); assert.equal(calls, 1);
  const invalid = new WorkflowRuntime({ store: new JsonStore(path.join(dir, 'invalid.json'), { workflowRuns: [] }), accountId: 'invalid', resultDecider: async () => ({ decision: 'complete', extra: true }), workflows: [{ workflowId: 'decision.fixture', version: '1', steps: ['step'] }] }); const invalidRun = invalid.startPlan({ workflowId: 'decision.fixture', version: '1', params: {} }); await invalid.pauseRun(invalidRun.runId); await assert.rejects(invalid.decideResult(invalidRun.runId), /invalid/);
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
testAsync('ApiClient result decision preserves the original run boundary', async () => {
  let seen;
  const api = new ApiClient({ baseUrl: 'https://license.example', authStore: { getToken: () => 'token' }, fetchImpl: async (url, options) => { seen = { url, options }; return { ok: true, status: 200, json: async () => ({ runId: 'run-1', decision: 'wait_human' }) }; } });
  const result = await api.resultDecision('run-1', { status: 'UNKNOWN', summary: { reason: 'fixture' }, idempotencyKey: 'result-key-001' });
  assert.equal(result.decision, 'wait_human'); assert.equal(seen.url, 'https://license.example/v1/workflow-runs/run-1/result-decision'); assert.equal(seen.options.headers.Authorization, 'Bearer token');
});
testAsync('ApiClient workflow lease methods preserve device lease endpoints', async () => {
  const requests = [];
  const api = new ApiClient({ baseUrl: 'https://license.example', authStore: { getToken: () => 'token' }, fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, json: async () => ({ runId: 'run-1', action: 'renewed', lease: { deviceId: 'device-a' } }) }; } });
  await api.acquireWorkflowLease('run-1', { ttlMs: 120000, idempotencyKey: 'lease-acquire-001' });
  await api.renewWorkflowLease('run-1', { ttlMs: 120000, idempotencyKey: 'lease-renew-001' });
  await api.releaseWorkflowLease('run-1', { idempotencyKey: 'lease-release-001' });
  assert.equal(requests[0].url, 'https://license.example/v1/workflow-runs/run-1/lease/acquire');
  assert.equal(requests[1].url, 'https://license.example/v1/workflow-runs/run-1/lease/renew');
  assert.equal(requests[2].url, 'https://license.example/v1/workflow-runs/run-1/lease/release');
  assert.equal(requests[2].options.headers.Authorization, 'Bearer token');
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
