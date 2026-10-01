'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { JsonStore } = require('./lib/json-store');
const { AuthStore } = require('./lib/auth-store');
const { ApiClient } = require('./lib/api-client');
const { BrowserBridge, isAllowedUrl } = require('./lib/browser-bridge');
const { ProbeBridge } = require('./lib/probe-bridge');
const { DEFAULT_SELECTOR_PROFILE, normalizeProfile } = require('./lib/selectors');
const { TaskEngine } = require('./lib/task-engine');
const { WorkflowRuntime } = require('./lib/workflow-runtime');
const { createWorkflowAdapter } = require('./lib/workflow-adapter');
const workflowRequest = require('./lib/workflow-request');
const { platformWorkflowDefinitions, workflowContractHash } = require('./lib/workflow-contracts');
const { AccountRuntimeManager } = require('./lib/account-runtime-manager');
const { platformAccountId: normalizePlatformAccountId, platformScope, accountDataPath: scopedAccountDataPath, accountDir: scopedAccountDir, browserPartition, sidecarPort: scopedSidecarPort } = require('./lib/platform-account');
const { targetUrl, text, safeIdempotencyKey } = require('./lib/validation');

let mainWindow;
let authStore;
let api;
let dataStore;
let engine;
let workflowRuntime;
let workflowManager;
let browser;
let browserState = { connected: false, collector: 'closed', matchCount: 0 };
let lastProbe = null;
let apiEndpoint;
let uiFrameUrl;
let sessionEpoch = 0;
let currentAccountUserId = null;
let currentPlatformAccountId = null;
let platformAccounts = [];
const workflowAccountRuns = new Map();
let loginAttempt = 0;
let accountTransition = Promise.resolve();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });

function publicLicensePayload(value) {
  return { user: value?.user || null, balance: value?.balance ?? null, features: value?.features || {}, device: value?.device || null, policy: value?.policy || null };
}

function validateEndpoint(value) {
  const url = new URL(text(value, 'server URL', 500));
  if (url.username || url.password || url.search || url.hash) throw new Error('授权中心地址不能包含账号、密码、查询参数或片段');
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) throw new Error('授权中心地址必须使用 HTTPS，开发环境只允许 localhost');
  return url.href.replace(/\/+$/, '');
}

function defaultData() {
  return { tasks: [], events: [], leads: [], logs: [], pending: [], chat: [], workflowRuns: [], selectorProfile: DEFAULT_SELECTOR_PROFILE };
}

// These fixed contracts are the platform boundary. Adapters may execute only
// their declared steps and must return an explicitly verifiable result.
const PLATFORM_WORKFLOWS = platformWorkflowDefinitions();

function accountDataPath(userId, platformAccount = currentPlatformAccountId) {
  return scopedAccountDataPath(app.getPath('userData'), apiEndpoint, userId || 'guest', platformAccount);
}

function accountDir(userId, platformAccount = currentPlatformAccountId) {
  return scopedAccountDir(app.getPath('userData'), apiEndpoint, userId || 'guest', platformAccount);
}

function sidecarPort(userId, platformAccount = currentPlatformAccountId) {
  const knownAccounts = platformAccounts.map((account) => account?.id).filter(Boolean);
  return scopedSidecarPort(apiEndpoint, userId || 'guest', platformAccount, knownAccounts);
}

function runtimeAccountId(userId, platformAccount) {
  return platformScope({ workbenchUserId: userId || 'guest', platformAccountId: platformAccount }).runtimeAccountId;
}

const WORKFLOW_PAUSE_COLLECTORS = new Set(['open_error', 'error', 'capability_error', 'closed', 'disconnected', 'close_error', 'close_timeout']);

function browserPauseReason(status) {
  const collector = typeof status?.collector === 'string' ? status.collector : '';
  if (!WORKFLOW_PAUSE_COLLECTORS.has(collector) && !(status?.connected === false && status?.disconnected === true)) return null;
  const detail = typeof status?.error === 'string' && status.error.trim() ? `:${status.error.trim().slice(0, 240)}` : '';
  return `browser_${collector || 'disconnected'}${detail}`;
}

function pauseWorkflowForBrowserStatus(accountId, runtime, status) {
  const reason = browserPauseReason(status);
  if (!reason) return;
  try { runtime?.invalidate(reason); } catch (error) { console.warn('[workflow] failed to persist browser pause', error.message); }
  if (accountId) workflowManager?.invalidate(accountId, reason);
}

function createBrowserInstance(userId, platformAccount = currentPlatformAccountId, callbacks = {}) {
  const common = { onStatus: callbacks.onStatus || (() => {}), onEvents: callbacks.onEvents || (() => {}) };
  // The Electron DOM bridge is an offline development fallback only.  A
  // packaged build must always use the bundled sidecar, even if an inherited
  // environment variable happens to enable the fallback.
  return process.env.DOUYIN_ELECTRON_BRIDGE === '1' && !app.isPackaged
    ? new BrowserBridge({ parentWindow: mainWindow, getPartition: () => browserPartition(apiEndpoint, userId || 'guest', platformAccount), ...common })
    : new ProbeBridge({ accountDir: accountDir(userId, platformAccount), port: sidecarPort(userId, platformAccount), cwd: path.resolve(__dirname, '..', '..'), resourcesPath: process.resourcesPath, packaged: app.isPackaged, ...common });
}

async function createBrowser(userId, platformAccount = currentPlatformAccountId) {
  const previous = browser;
  browser = null;
  if (previous) await previous.close?.();
  const callbackEpoch = sessionEpoch;
  const accountId = userId && platformAccount ? runtimeAccountId(userId, platformAccount) : null;
  browser = createBrowserInstance(userId, platformAccount, {
    onStatus: (status) => { if (callbackEpoch !== sessionEpoch) return; pauseWorkflowForBrowserStatus(accountId, workflowRuntime, status); if (status.navigating) engine?.pauseAll('browser_navigation'); if (['captcha', 'login_required', 'unsupported'].includes(status.status)) engine?.pauseAll(`sidecar_${status.status}`); if (browserPauseReason(status)) engine?.pauseAll(browserPauseReason(status)); browserState = { ...browserState, ...status }; emitState(); },
    onEvents: (events) => { if (callbackEpoch !== sessionEpoch) return; void engine?.ingest(events); }
  });
}

function createWorkflowRuntimeForStore(store, userId = null, platformAccount = null, browserOverride = browser) {
  const scopedRuntimeId = runtimeAccountId(userId, platformAccount);
  const adapter = createWorkflowAdapter({ browser: browserOverride });
  return new WorkflowRuntime({
    store,
    accountId: scopedRuntimeId,
    workflows: PLATFORM_WORKFLOWS,
    modelDecider: async ({ intent, context }) => {
      if (typeof api?.plan !== 'function') throw new Error('授权中心尚未提供 Agent 规划能力');
      const idempotencyKey = safeIdempotencyKey(`plan:${scopedRuntimeId}:${crypto.createHash('sha256').update(JSON.stringify({ intent, context })).digest('hex').slice(0, 48)}`);
      return api.plan({ intent, context, idempotencyKey });
    },
    // The platform owns the adapter boundary. It can call a collaborator
    // method, but it still maps every result through the fixed workflow
    // contract and keeps unverified sends fail-closed.
    stepExecutor: adapter.execute,
    reconcileAction: adapter.reconcile,
    healthCheck: async ({ run }) => {
      if (!run.remoteRunId) return { ok: true, source: 'local-checkpoint' };
      if (run.plan?.params?.url && typeof browserOverride?.isOpenFor === 'function' && !browserOverride.isOpenFor(run.plan.params.url)) return { ok: false, reason: 'workflow_target_not_open' };
      if (typeof api?.workflowRun !== 'function') return { ok: false, reason: 'workflow_status_api_unavailable' };
      const remote = await api.workflowRun(run.remoteRunId);
      const status = remote?.run?.status;
      return { ok: Boolean(status && !['FAILED', 'COMPLETED', 'STOPPED'].includes(status)), status };
    },
    onStateChange: emitState
  });
}

function createEngineForStore(nextStore, userId = null, platformAccount = currentPlatformAccountId) {
  dataStore = nextStore;
  currentAccountUserId = userId;
  engine = new TaskEngine({ store: dataStore, api, authStore, browser, selectorProfile: currentProfile(), onStateChange: emitState, ensureLicense: refreshLicense });
  workflowRuntime = createWorkflowRuntimeForStore(dataStore, userId, platformAccount);
}

function registerWorkflowAccount(userId, platformAccount) {
  if (!workflowManager || !userId || !platformAccount) throw new Error('工作流账号运行时尚未准备好');
  const id = runtimeAccountId(userId, platformAccount);
  workflowManager.register(id, { workbenchUserId: userId, platformAccountId: platformAccount, reactivate: true });
  return id;
}

function invalidateManagedWorkflows(reason, predicate = () => true) {
  if (!workflowManager) return;
  for (const account of workflowManager.snapshot().accounts) if (predicate(account.accountId)) workflowManager.invalidate(account.accountId, reason);
}

async function closeInvalidatedWorkflows() {
  await workflowManager?.closeInvalidated?.();
  for (const [accountId] of workflowAccountRuns) {
    const account = (workflowManager?.snapshot?.()?.accounts || []).find((item) => item.accountId === accountId);
    if (!account || account.status === 'invalidated' || account.status === 'closed') workflowAccountRuns.delete(accountId);
  }
}

function switchAccountStore(userId, reason = 'account_switch', isCurrent = () => true, platformAccount = currentPlatformAccountId) {
  const ownEpoch = ++sessionEpoch;
  const transition = accountTransition.then(async () => {
    if (ownEpoch !== sessionEpoch || !isCurrent()) return false;
    const targetPlatformAccount = userId ? (platformAccount || null) : null;
    const previousWorkflowAccountId = currentAccountUserId && currentPlatformAccountId
      ? runtimeAccountId(currentAccountUserId, currentPlatformAccountId)
      : null;
    browserState = { connected: false, collector: 'closed', matchCount: 0 };
    lastProbe = null;
    engine?.invalidate(reason);
    workflowRuntime?.invalidate(reason);
    if (previousWorkflowAccountId) {
      // Invalidate the exact account before closing its browser.  This aborts
      // queued/running manager jobs and prevents the old account from sending
      // after the new platform account becomes current.
      invalidateManagedWorkflows(reason, (accountId) => accountId === previousWorkflowAccountId);
      await closeInvalidatedWorkflows();
    }
    const previous = browser;
    if (previous) await previous.close?.();
    if (ownEpoch !== sessionEpoch || !isCurrent()) return false;
    browser = null;
    currentPlatformAccountId = targetPlatformAccount;
    if (!userId) platformAccounts = [];
    authStore?.setLicense(null);
    await createBrowser(userId, targetPlatformAccount);
    if (ownEpoch !== sessionEpoch || !isCurrent()) {
      const created = browser;
      browser = null;
      await created?.close?.();
      return false;
    }
    createEngineForStore(new JsonStore(accountDataPath(userId, targetPlatformAccount), defaultData), userId, targetPlatformAccount);
    return true;
  });
  accountTransition = transition.catch(() => {});
  return transition;
}

function assertLocalSender(event) {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== uiFrameUrl) {
    throw new Error('IPC sender rejected');
  }
}

function emitState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent:state', { ...engine.snapshot(), browser: browserState, workflow: workflowRuntime?.snapshot() || { accountId: runtimeAccountId(currentAccountUserId, currentPlatformAccountId), runs: [] }, workflowAccounts: [...workflowAccountRuns.values()], platformAccounts, platformAccountId: currentPlatformAccountId });
}

const COMPOSED_WORKFLOW_LIMIT = 8;
const REPLY_WORKFLOW_IDS = new Set(['comment.batch', 'comment.reply_then_private', 'live.batch', 'live.reply_then_private']);
function checkpointIdempotencyKey(remoteRunId, status, expectedVersion, stepId, suffix = '') {
  return safeIdempotencyKey(`checkpoint:${remoteRunId}:${status}:${expectedVersion ?? 'current'}:${stepId ?? 'current'}:${suffix}`);
}
const RESULT_SECRET_KEY = /(token|password|secret|authorization|cookie|localstorage|credential|api.?key)/i;
function resultEvidence(value, depth = 0, key = '') {
  if (RESULT_SECRET_KEY.test(key)) return '[REDACTED]';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 600 ? `${value.slice(0, 600)}…` : value;
  if (depth >= 3) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => resultEvidence(item, depth + 1, key));
  if (typeof value !== 'object') return null;
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (Object.keys(output).length >= 32) break;
    output[childKey] = resultEvidence(childValue, depth + 1, childKey);
  }
  return output;
}

function resultSummary(result) {
  const steps = Array.isArray(result?.steps) ? result.steps.slice(0, 12).map((step) => ({
    stepId: step.stepId,
    status: step.status,
    resultStatus: step.resultStatus,
    result: resultEvidence(step.result),
  })) : [];
  return { currentStep: result.currentStep, checkpoint: resultEvidence(result.checkpoint), failure: resultEvidence(result.lastError), plan: result.plan ? { workflowId: result.plan.workflowId, version: result.plan.version } : null, steps };
}

async function requestResultDecision(remoteRunId, result) {
  if (!remoteRunId || !result || result.status === 'RUNNING') return null;
  if (typeof api?.resultDecision !== 'function') return { state: 'unavailable', reason: 'result_decision_api_unavailable', requiresManualGate: true };
  const idempotencyKey = safeIdempotencyKey(`result:${remoteRunId}:${result.status}:${result.currentStep ?? 'final'}`);
  const request = { status: result.status, summary: resultSummary(result), idempotencyKey };
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await api.resultDecision(remoteRunId, request);
      return { ...response, requiresManualGate: result.status === 'UNKNOWN' || result.status === 'WAITING_HUMAN' };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  return { state: 'unavailable', code: lastError?.code || 'RESULT_DECISION_FAILED', reason: lastError?.message || '结果决策暂时不可用', requiresManualGate: true, retryable: true };
}

async function materializeNextWorkflowPlan(nextPlan, currentPlan) {
  if (!nextPlan || typeof nextPlan !== 'object' || typeof nextPlan.planId !== 'string' || typeof nextPlan.workflowId !== 'string' || nextPlan.params == null || typeof nextPlan.params !== 'object') throw new Error('授权中心返回的下一流程计划无效');
  if (!REPLY_WORKFLOW_IDS.has(nextPlan.workflowId)) return { planId: nextPlan.planId, workflowId: nextPlan.workflowId, version: nextPlan.version, params: nextPlan.params };
  const params = { ...nextPlan.params };
  const knowledgeSetId = typeof params.knowledgeSetId === 'string' && params.knowledgeSetId.trim()
    ? params.knowledgeSetId.trim()
    : (typeof currentPlan?.params?.knowledgeSetId === 'string' ? currentPlan.params.knowledgeSetId.trim() : '');
  if (!knowledgeSetId) throw new Error('下一回复流程缺少租户话术库，已转人工');
  const query = Array.isArray(params.keywords) ? params.keywords.join('、') : '继续处理目标';
  const frozen = await prepareReplyPlan({ workflowId: nextPlan.workflowId, version: nextPlan.version, params: { ...params, knowledgeSetId }, knowledgeSetId, knowledgeSetVersion: params.knowledgeSetVersion, query });
  if (frozen?.status !== 'issued' || !frozen.planId || !frozen.params) throw new Error(frozen?.status === 'UNKNOWN' ? '下一流程话术结果未知，已转人工' : '下一流程未获得授权中心冻结话术');
  return { planId: frozen.planId, workflowId: frozen.workflowId, version: frozen.version, params: frozen.params };
}

async function applyResultDecisionAndCompose({ runtime, accountId, accountContext, requestedPlatform, deviceId, result, nextDecision, compositionDepth = 0 }) {
  let decisionApplied = null;
  let nextRun = null;
  const sendWorkflow = Array.isArray(result?.steps) && result.steps.some((step) => step && step.sideEffect === true);
  const sendEvidenceMissing = result?.status === 'COMPLETED' && sendWorkflow;
  const reportedCheckpoint = sendEvidenceMissing ? { ...(result.checkpoint || {}), phase: 'send', reason: 'server_send_evidence_required' } : (result.checkpoint || {});
  if (nextDecision?.decision === 'wait_human' && (sendEvidenceMissing || ['UNKNOWN', 'CHECKPOINT', 'WAITING_HUMAN', 'PAUSED'].includes(result.status))) {
    decisionApplied = runtime.applyResultDecision(result.runId, 'wait_human', { reason: sendEvidenceMissing ? 'server_send_evidence_required' : 'server_result_decision', checkpoint: reportedCheckpoint || null });
  } else if (nextDecision?.decision && result.status === 'COMPLETED' && ['continue', 'complete'].includes(nextDecision.decision)) {
    if (nextDecision.decision === 'continue') {
      if (!nextDecision.nextPlan) throw new Error('授权中心未提供下一流程计划，已停止自动接续');
      if (compositionDepth >= COMPOSED_WORKFLOW_LIMIT) throw new Error('连续流程达到安全上限，已转人工');
    }
    decisionApplied = runtime.applyResultDecision(result.runId, nextDecision.decision, { reason: 'server_result_decision' });
    if (nextDecision.decision === 'continue') {
      const plan = await materializeNextWorkflowPlan(nextDecision.nextPlan, result.plan);
      nextRun = await startWorkflowRun({ accountId, accountContext, plan, requestedPlatform, deviceId, compositionDepth: compositionDepth + 1 });
    }
  } else if (nextDecision?.decision) {
    decisionApplied = { action: 'suggested', decision: nextDecision.decision, requiresManualGate: true };
  } else if (nextDecision?.requiresManualGate) {
    // Keep the local terminal result visible while making the unresolved
    // server decision explicit.  The remote credit hold remains untouched;
    // callers must retry or use an audited human action before it can settle.
    decisionApplied = { action: 'manual_gate', requiresManualGate: true, retryable: nextDecision.retryable === true, reason: nextDecision.reason || '结果决策暂时不可用', run: { ...result, resultDecisionPending: true, lastError: { code: nextDecision.code || 'RESULT_DECISION_REQUIRED', message: nextDecision.reason || '结果决策暂时不可用' } } };
  }
  return { decisionApplied, nextRun };
}

async function solidifyRemoteWorkflow(remoteRunId, reason, localRun = null, leaseContext = null) {
  if (!remoteRunId || typeof api?.workflowRun !== 'function') return;
  try {
    const remote = await api.workflowRun(remoteRunId);
    if (remote?.run?.status !== 'RUNNING') return;
    const run = remote.run;
    // A heartbeat failure may have let the lease expire before this catch
    // handler runs. Reclaim the same device-scoped lease before persisting the
    // human/UNKNOWN checkpoint; otherwise the remote run can remain RUNNING
    // while the local runtime is already paused.
    if (leaseContext?.accountId && leaseContext?.deviceId && typeof api.acquireWorkflowLease === 'function') {
      await api.acquireWorkflowLease(remoteRunId, {
        ttlMs: 120000,
        idempotencyKey: safeIdempotencyKey(`lease:solidify:${remoteRunId}:${leaseContext.accountId}:${leaseContext.deviceId}:${run.checkpointVersion ?? 0}`)
      });
    }
    const stepId = String(run.currentStep ?? localRun?.currentStep ?? 0);
    const step = Array.isArray(run.contract?.steps) ? run.contract.steps.find((item) => (typeof item === 'string' ? item : item?.stepId || item?.id) === stepId) : null;
    const sideEffect = Boolean((typeof step === 'object' && step?.sideEffect === true) || localRun?.steps?.[localRun.currentStep]?.sideEffect === true);
    const currentTarget = run.checkpoint?.targetState && typeof run.checkpoint.targetState === 'object' ? run.checkpoint.targetState : {};
    const operationId = typeof currentTarget.operationId === 'string' && currentTarget.operationId.trim()
      ? currentTarget.operationId
      : `workflow:${remoteRunId}:step:${stepId}`;
    const status = sideEffect ? 'UNKNOWN' : 'WAITING_HUMAN';
    const targetState = { ...currentTarget, phase: sideEffect ? 'send' : 'workflow', operationId, reason: String(reason || '桌面端流程异常，等待人工核对') };
    await api.checkpointWorkflow(remoteRunId, {
      status,
      stepId,
      expectedVersion: run.checkpointVersion,
      idempotencyKey: checkpointIdempotencyKey(remoteRunId, status, run.checkpointVersion, stepId, sideEffect ? 'unknown' : 'human'),
      targetState,
      humanWait: { reason: String(reason || '桌面端流程异常，等待人工核对'), context: { source: 'desktop_platform', operationId } },
      failure: { code: sideEffect ? 'DESKTOP_SIDE_EFFECT_UNKNOWN' : 'DESKTOP_WORKFLOW_INTERRUPTED', message: String(reason || '桌面端流程异常') }
    });
  } catch (error) {
    console.warn('[workflow] failed to solidify remote run', remoteRunId, error.message);
  }
}

function startLeaseHeartbeat(remoteRunId, accountId, deviceId) {
  let failure = null;
  const timer = setInterval(() => {
    api.renewWorkflowLease(remoteRunId, { ttlMs: 120000, idempotencyKey: safeIdempotencyKey(`lease:heartbeat:${remoteRunId}:${accountId}:${deviceId}:${Date.now()}`) }).catch((error) => {
      if (!failure) failure = error;
    });
  }, 30_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer), error: () => failure, assertHealthy: () => { if (failure) throw new Error(`授权端流程租约续期失败，已暂停并等待人工：${failure.message}`); } };
}

function currentProfile() { return dataStore.get().selectorProfile || DEFAULT_SELECTOR_PROFILE; }

function normalizedPlatformAccounts(payload, includeDisabled = false) {
  const rows = Array.isArray(payload) ? payload : payload?.accounts;
  if (!Array.isArray(rows)) throw new Error('授权中心返回的平台账号列表无效');
  return rows.filter((item) => item && typeof item.id === 'string' && item.id.trim() && (includeDisabled || item.status !== 'disabled')).map((item) => ({ ...item, id: normalizePlatformAccountId(item.id) }));
}

async function fetchPlatformAccounts(requestApi = api, tokenOverride = null, includeDisabled = false) {
  const response = await requestApi.platformAccounts(tokenOverride || authStore.getToken());
  return normalizedPlatformAccounts(response, includeDisabled);
}

function preferredPlatformAccount(userId, accounts) {
  const persisted = authStore.getPlatformAccountId(userId);
  return accounts.find((item) => item.id === persisted)?.id || accounts[0]?.id || null;
}

async function switchPlatformAccount(platformAccount) {
  if (!currentAccountUserId || !authStore.getToken()) throw new Error('请先登录工作台');
  const selected = normalizePlatformAccountId(platformAccount);
  const requestToken = authStore.getToken();
  const requestApi = api;
  const accounts = await fetchPlatformAccounts(requestApi, requestToken);
  if (!accounts.some((item) => item.id === selected)) throw new Error('平台账号不属于当前工作台或已停用');
  if (selected === currentPlatformAccountId) { platformAccounts = accounts; authStore.setPlatformAccountId(currentAccountUserId, selected); emitState(); return { accounts, platformAccountId: selected }; }
  const license = authStore.getLicense();
  // Make the complete account set available while constructing the new
  // browser, so its deterministic allocator can avoid another account's hash
  // port before either sidecar is launched.
  platformAccounts = accounts;
  const switched = await switchAccountStore(currentAccountUserId, 'platform_account_switch', () => requestApi === api && authStore.getToken() === requestToken, selected);
  if (!switched) throw new Error('平台账号切换已过期');
  platformAccounts = accounts;
  authStore.setPlatformAccountId(currentAccountUserId, selected);
  if (license) engine.setLicense(license);
  emitState();
  return { accounts, platformAccountId: selected };
}

async function createPlatformAccount(input) {
  if (!currentAccountUserId || !authStore.getToken()) throw new Error('请先登录工作台');
  const platform = text(input?.platform || 'douyin', 'platform', 40);
  const accountRef = text(input?.accountRef, 'accountRef', 200);
  const displayName = input?.displayName == null || input.displayName === '' ? '' : text(input.displayName, 'displayName', 200);
  const requestToken = authStore.getToken();
  const created = await api.createPlatformAccount({ platform, accountRef, displayName }, requestToken);
  const selected = normalizePlatformAccountId(created?.id);
  const result = await switchPlatformAccount(selected);
  return { account: created, ...result };
}

async function listPlatformAccounts() {
  if (!currentAccountUserId || !authStore.getToken()) throw new Error('请先登录工作台');
  const accounts = await fetchPlatformAccounts(api, authStore.getToken());
  platformAccounts = accounts;
  if (currentPlatformAccountId && !accounts.some((item) => item.id === currentPlatformAccountId)) {
    const selected = preferredPlatformAccount(currentAccountUserId, accounts);
    if (selected) await switchPlatformAccount(selected);
    else {
      invalidateManagedWorkflows('platform_account_unavailable');
      await closeInvalidatedWorkflows();
      await switchAccountStore(currentAccountUserId, 'platform_account_unavailable', () => Boolean(authStore.getToken()), null);
      authStore.setPlatformAccountId(currentAccountUserId, null);
    }
  }
  emitState();
  return { accounts: platformAccounts, platformAccountId: currentPlatformAccountId };
}

async function refreshLicense(tokenOverride = null) {
  const requestEpoch = sessionEpoch;
  const requestApi = api;
  const requestToken = tokenOverride || authStore.getToken();
  if (!requestToken) {
    engine.invalidate('unauthorized');
    emitState();
    return { state: 'unauthorized' };
  }
  try {
    const me = await requestApi.me(requestToken);
    if (requestEpoch !== sessionEpoch || requestApi !== api || authStore.getToken() !== requestToken) return { state: 'stale' };
    const safe = publicLicensePayload(me);
    if (!safe.user?.id) throw new Error('授权中心响应缺少用户身份');
    const allAccounts = await fetchPlatformAccounts(requestApi, requestToken, true);
    const accounts = allAccounts.filter((item) => item.status !== 'disabled');
    const selected = preferredPlatformAccount(safe.user.id, accounts);
    const currentRecord = allAccounts.find((item) => item.id === currentPlatformAccountId);
    const currentStillValid = currentPlatformAccountId && accounts.some((item) => item.id === currentPlatformAccountId);
    const currentDisabled = Boolean(currentRecord && currentRecord.status === 'disabled');
    const needsAccountSwitch = currentAccountUserId !== safe.user.id
      || (!currentStillValid && currentPlatformAccountId != null)
      || (currentPlatformAccountId == null && selected != null);
    if (needsAccountSwitch) {
      if (currentAccountUserId !== safe.user.id) invalidateManagedWorkflows('workbench_account_switch');
      if (currentDisabled) {
        invalidateManagedWorkflows('platform_account_disabled');
        await closeInvalidatedWorkflows();
      }
      platformAccounts = accounts;
      const switched = await switchAccountStore(safe.user.id, 'account_switch_from_refresh', () => requestApi === api && authStore.getToken() === requestToken, selected);
      if (!switched) return { state: 'stale' };
      if (selected) authStore.setPlatformAccountId(safe.user.id, selected);
      else authStore.setPlatformAccountId(safe.user.id, null);
    }
    platformAccounts = accounts;
    engine.setLicense(safe);
    return engine.publicLicense();
  } catch (error) {
    if (requestEpoch !== sessionEpoch || requestApi !== api) return { state: 'stale' };
    engine.invalidate('license_offline');
    authStore.setLicense(null);
    const data = dataStore.get();
    for (const task of data.tasks) if (task.status === 'running') task.status = 'offline';
    dataStore.set(data);
    browserState = { ...browserState, license: 'offline', error: error.message };
    emitState();
    throw error;
  }
}

async function handleLogin(_event, input) {
  const username = text(input?.username, 'username', 160);
  const password = text(input?.password, 'password', 512);
  const device = authStore.getDevice();
  const attempt = ++loginAttempt;
  const requestApi = api;
  const response = await requestApi.login({ username, password, deviceId: device.id, deviceName: device.name });
  if (!response.token) throw new Error('授权中心响应缺少 token');
  try {
    const me = await requestApi.me(response.token);
    if (attempt !== loginAttempt || requestApi !== api) throw new Error('登录会话已切换，请重试');
    const safe = publicLicensePayload(me);
    if (!safe.user?.id) throw new Error('授权中心响应缺少用户身份');
    const accounts = await fetchPlatformAccounts(requestApi, response.token);
    const selected = preferredPlatformAccount(safe.user.id, accounts);
    invalidateManagedWorkflows('login_account_switch');
    await closeInvalidatedWorkflows();
    platformAccounts = accounts;
    const switched = await switchAccountStore(safe.user.id, 'login_account_switch', () => attempt === loginAttempt && requestApi === api, selected);
    if (!switched || attempt !== loginAttempt || requestApi !== api) throw new Error('登录会话已切换，请重试');
    platformAccounts = accounts;
    if (selected) authStore.setPlatformAccountId(safe.user.id, selected);
    authStore.setSession(response.token, safe, requestApi.baseUrl);
    engine.setLicense(safe);
    return engine.publicLicense();
  } catch (error) {
    if (attempt === loginAttempt) authStore.clear();
    throw new Error(`登录后授权检查失败：${error.message}`);
  }
}

async function handleLogout() {
  loginAttempt += 1;
  const requestApi = api;
  const requestToken = authStore.getToken();
  invalidateManagedWorkflows('logout');
  await closeInvalidatedWorkflows();
  authStore.clear();
  await switchAccountStore(null, 'logout');
  dataStore.update((data) => { for (const task of data.tasks) if (task.status === 'running') task.status = 'license_required'; return data; });
  emitState();
  try { if (requestToken) await requestApi.logout(requestToken); } catch (error) { console.warn('[auth] logout request failed', error.message); }
  return { state: 'unauthorized' };
}

async function configureEndpoint(_event, value) {
  const next = validateEndpoint(value);
  if (next !== apiEndpoint) {
    loginAttempt += 1;
    invalidateManagedWorkflows('endpoint_changed');
    await closeInvalidatedWorkflows();
    authStore.clear();
    authStore.setEndpoint(next);
    apiEndpoint = next;
    api = new ApiClient({ baseUrl: apiEndpoint, authStore });
    await switchAccountStore(null, 'endpoint_changed');
    engine.setLicense(null);
    dataStore.update((data) => { for (const task of data.tasks) if (task.status === 'running') task.status = 'license_required'; return data; });
  }
  emitState();
  return { apiEndpoint };
}

async function handleRedeem(_event, input) {
  if (!authStore.getToken()) throw new Error('请先登录');
  const code = text(input?.code, 'code', 200);
  const idempotencyKey = safeIdempotencyKey(`redeem:${crypto.createHash('sha256').update(code).digest('hex').slice(0, 32)}`);
  const requestEpoch = sessionEpoch;
  const requestApi = api;
  const requestToken = authStore.getToken();
  const result = await requestApi.redeem({ code, idempotencyKey }, requestToken);
  if (requestEpoch !== sessionEpoch || requestApi !== api || authStore.getToken() !== requestToken) throw new Error('授权会话已切换，兑换结果未应用');
  engine.setLicense({ ...engine.publicLicense(), ...result });
  return result;
}

async function startWorkflowRun({ accountId, accountContext, plan, requestedPlatform, deviceId, chatMessage = null, compositionDepth = 0 }) {
    const runtime = accountContext.runtime;
    let localRun = null;
    let remoteRunId = null;
    const catalogResponse = await api.workflows();
    const catalog = Array.isArray(catalogResponse?.workflows) ? catalogResponse.workflows : [];
    const registered = catalog.find((item) => item.workflowId === plan.workflowId && String(item.version) === String(plan.version) && item.status === 'active');
    if (!registered) throw new Error('授权中心未开放该固定流程');
    const canonical = PLATFORM_WORKFLOWS.find((item) => item.workflowId === registered.workflowId && String(item.version) === String(registered.version));
    if (!canonical || !registered.contract || typeof registered.contractHash !== 'string' || !registered.contractHash) throw new Error('授权中心固定流程缺少本地可验证的契约指纹，已拒绝启动');
    const effectiveLocalContract = { ...canonical, ...(Number.isSafeInteger(registered.contract.creditPrice) ? { creditPrice: registered.contract.creditPrice } : {}) };
    if (workflowContractHash(effectiveLocalContract) !== registered.contractHash) throw new Error('授权中心固定流程契约与客户端不一致，已拒绝启动');
    const contractSteps = canonical.steps;
    if (!contractSteps.length) throw new Error('授权中心返回的固定流程没有可执行步骤');
    runtime.registerWorkflow({ workflowId: registered.workflowId, version: String(registered.version), steps: contractSteps });
    // Workflow pricing is authoritative on the server.  Reserve the exact
    // server-issued amount before creating a run; the server settles it only
    // after a terminal, verified result decision.  A transport-unknown
    // reservation is deliberately left to its bounded TTL instead of being
    // guessed as refundable, preventing duplicate side effects.
    let creditAction = null;
    const creditPrice = Number.isSafeInteger(registered.contract?.creditPrice) ? registered.contract.creditPrice : null;
    if (creditPrice !== null && creditPrice > 0) {
      const reservation = await api.reserveCreditAction({
        actionKey: safeIdempotencyKey(`workflow-credit:${plan.planId}:${requestedPlatform}:${registered.workflowId}:${registered.version}`),
        owner: `workflow:${registered.workflowId}`,
        amount: creditPrice,
        metadata: { planId: plan.planId, workflowId: registered.workflowId, version: String(registered.version), platformAccountId: requestedPlatform }
      });
      creditAction = reservation?.action || null;
      if (!creditAction?.id || creditAction.status !== 'reserved') throw new Error('授权中心未返回有效的积分预留');
      const license = engine.publicLicense();
      engine.setLicense({ ...license, balance: reservation.balance });
    }
    // Persist the frozen local plan before creating the remote mirror.  A
    // process exit during the HTTP handshake then leaves a resumable local
    // checkpoint instead of a remote RUNNING record with no local run.
    try {
      localRun = runtime.startPlan(plan);
    } catch (error) {
      if (creditAction?.id) {
        try { await api.releaseCreditAction(creditAction.id, { idempotencyKey: safeIdempotencyKey(`workflow-credit-release:${plan.planId}:${requestedPlatform}`) }); } catch (releaseError) { console.warn('[workflow] credit release failed', creditAction.id, releaseError.message); }
      }
      throw error;
    }
    workflowAccountRuns.set(accountId, { accountId, platformAccountId: requestedPlatform, run: localRun });
    emitState();
    let remote;
    try {
      remote = await api.createWorkflowRun({ planId: plan.planId, workflowId: plan.workflowId, version: plan.version, params: plan.params, platformAccountId: requestedPlatform, creditActionId: creditAction?.id, knowledgeSetId: typeof plan.params.knowledgeSetId === 'string' ? plan.params.knowledgeSetId : undefined, idempotencyKey: safeIdempotencyKey(`run:${plan.planId}:${requestedPlatform}`) });
    } catch (error) {
      runtime.pauseRun(localRun.runId, 'remote_workflow_not_created');
      // A definite HTTP rejection means no run was accepted by the server;
      // release the local reservation.  Network/timeout errors remain
      // indeterminate and are recovered through the action TTL/query path.
      if (creditAction?.id && Number.isInteger(error?.status) && error.status > 0) {
        try { await api.releaseCreditAction(creditAction.id, { idempotencyKey: safeIdempotencyKey(`workflow-credit-release:${plan.planId}:${requestedPlatform}`) }); } catch (releaseError) { console.warn('[workflow] credit release failed', creditAction.id, releaseError.message); }
      }
      throw error;
    }
    remoteRunId = remote?.run?.id;
    if (!remoteRunId) {
      runtime.pauseRun(localRun.runId, 'remote_workflow_protocol_error');
      throw new Error('授权中心未返回流程实例，已暂停本地流程');
    }
    accountContext.store.update((data) => ({ ...data, workflowRuns: data.workflowRuns.map((candidate) => candidate.runId === localRun.runId ? { ...candidate, remoteRunId } : candidate) }));
    let leaseHeld = false;
    let leaseHeartbeat = null;
    let remoteVersion = Number.isSafeInteger(remote?.run?.checkpointVersion) ? remote.run.checkpointVersion : 0;
    try {
      await api.acquireWorkflowLease(remoteRunId, { ttlMs: 120000, idempotencyKey: safeIdempotencyKey(`lease:acquire:${remoteRunId}:${accountId}:${deviceId}`) });
      leaseHeld = true;
      const running = await api.checkpointWorkflow(remoteRunId, { status: 'RUNNING', expectedVersion: remoteVersion, idempotencyKey: checkpointIdempotencyKey(remoteRunId, 'RUNNING', remoteVersion, String(localRun.currentStep ?? 0), 'start') });
      remoteVersion = Number.isSafeInteger(running?.run?.checkpointVersion) ? running.run.checkpointVersion : remoteVersion + 1;
      const run = localRun;
      workflowAccountRuns.set(accountId, { accountId, platformAccountId: requestedPlatform, run: { ...run, status: 'RUNNING' } });
      emitState();
      leaseHeartbeat = startLeaseHeartbeat(remoteRunId, accountId, deviceId);
      const result = await runtime.run(run.runId);
      leaseHeartbeat.assertHealthy();
      workflowAccountRuns.set(accountId, { accountId, platformAccountId: requestedPlatform, run: result });
      await api.renewWorkflowLease(remoteRunId, { ttlMs: 120000, idempotencyKey: safeIdempotencyKey(`lease:renew:${remoteRunId}:${result.runId}:${result.status}:${deviceId}`) });
      const sendWorkflow = contractSteps.some((step) => step && step.sideEffect === true);
      const sendEvidenceMissing = result.status === 'COMPLETED' && sendWorkflow;
      const reportedStatus = sendEvidenceMissing ? 'WAITING_HUMAN' : result.status;
      const reportedCheckpoint = sendEvidenceMissing
        ? { ...(result.checkpoint || {}), phase: 'send', reason: 'server_send_evidence_required' }
        : (result.checkpoint || {});
      const finalRemote = await api.checkpointWorkflow(remoteRunId, { status: reportedStatus, stepId: String(result.currentStep), expectedVersion: remoteVersion, idempotencyKey: checkpointIdempotencyKey(remoteRunId, reportedStatus, remoteVersion, String(result.currentStep), 'result'), failure: sendEvidenceMissing ? { code: 'SEND_EVIDENCE_REQUIRED', message: '平台未提供授权端可验证的送达证据' } : (result.lastError || undefined), targetState: reportedCheckpoint, humanWait: reportedStatus === 'WAITING_HUMAN' ? { reason: sendEvidenceMissing ? '平台送达证据未验证，需人工检查' : (result.lastError?.message || '平台适配器需要人工处理'), context: reportedCheckpoint } : undefined });
      remoteVersion = Number.isSafeInteger(finalRemote?.run?.checkpointVersion) ? finalRemote.run.checkpointVersion : remoteVersion + 1;
      const reconciliationProof = finalRemote?.run?.checkpoint?.targetState?.reconciliationProof;
      if (result.status === 'UNKNOWN' && typeof reconciliationProof === 'string' && typeof runtime.setRecoveryProof === 'function') runtime.setRecoveryProof(result.runId, reconciliationProof);
      const nextDecision = sendEvidenceMissing ? { decision: 'wait_human', reason: 'server_send_evidence_required' } : await requestResultDecision(remoteRunId, result);
      leaseHeartbeat.assertHealthy();
      const applied = await applyResultDecisionAndCompose({ runtime, accountId, accountContext, requestedPlatform, deviceId, result, nextDecision, compositionDepth });
      const decisionApplied = applied.decisionApplied;
      const nextRun = applied.nextRun;
      if (nextDecision?.decision === 'wait_human' && (sendEvidenceMissing || ['UNKNOWN', 'CHECKPOINT', 'WAITING_HUMAN', 'PAUSED'].includes(result.status)) && result.status !== 'WAITING_HUMAN') {
        const humanCheckpoint = await api.checkpointWorkflow(remoteRunId, { status: 'WAITING_HUMAN', stepId: String(result.currentStep), expectedVersion: remoteVersion, idempotencyKey: checkpointIdempotencyKey(remoteRunId, 'WAITING_HUMAN', remoteVersion, String(result.currentStep), 'decision'), humanWait: { reason: sendEvidenceMissing ? '平台送达证据未验证，需人工检查' : 'Agent 结果决策要求人工处理', context: result.checkpoint || {} }, failure: result.lastError || undefined, targetState: result.checkpoint || {} });
        remoteVersion = Number.isSafeInteger(humanCheckpoint?.run?.checkpointVersion) ? humanCheckpoint.run.checkpointVersion : remoteVersion + 1;
      }
      const displayRun = decisionApplied?.run || result;
      workflowAccountRuns.set(accountId, { accountId, platformAccountId: requestedPlatform, run: displayRun });
      const searchResult = displayRun.steps?.find((step) => step.stepId === 'search')?.result;
      const searchHint = searchResult?.kind === 'video_search'
        ? `；找到 ${searchResult.videos?.length || 0} 个候选视频${(searchResult.videos || []).slice(0, 3).map((video) => `\n${video.title || video.url}`).join('')}`
        : '';
      const humanHint = displayRun.status === 'UNKNOWN' || displayRun.status === 'WAITING_HUMAN' || decisionApplied?.requiresManualGate ? '；需要人工处理后再继续' : '';
      const decisionHint = nextDecision?.decision ? `；结果决策：${nextDecision.decision}${nextRun ? `，已接续 ${nextRun.plan?.workflowId || nextRun.run?.workflowId || '下一流程'}` : ''}` : '';
      // 只有聊天触发才写聊天记录；任务面板触发时由面板自己展示检查点与统一台账，
      // 不往聊天里塞一条假的用户消息。
      if (chatMessage) {
        const assistantLine = '已选择固定流程 ' + plan.workflowId + '@' + plan.version + '，当前状态：' + displayRun.status + searchHint + humanHint + decisionHint;
        accountContext.store.update((data) => ({ ...data, chat: [...(Array.isArray(data.chat) ? data.chat : []), { role: 'user', content: chatMessage, at: new Date().toISOString() }, { role: 'assistant', content: assistantLine, runId: result.runId, at: new Date().toISOString() }].slice(-100) }));
      }
      emitState();
      return { plan, run: displayRun, nextDecision, decisionApplied, nextRun };
    } catch (error) {
      if (leaseHeld && remoteRunId) await solidifyRemoteWorkflow(remoteRunId, error.message, localRun, { accountId, deviceId });
      if (localRun && !['COMPLETED', 'FAILED', 'STOPPED', 'UNKNOWN', 'WAITING_HUMAN', 'PAUSED'].includes(runtime.getRun(localRun.runId).status)) {
        runtime.pauseRun(localRun.runId, remoteRunId ? 'remote_workflow_interrupted' : 'remote_workflow_not_created');
      }
      throw error;
    } finally {
      leaseHeartbeat?.stop();
      if (leaseHeld && remoteRunId) {
        try { await api.releaseWorkflowLease(remoteRunId, { idempotencyKey: safeIdempotencyKey(`lease:release:${remoteRunId}:${accountId}:${deviceId}`) }); } catch (error) { console.warn('[workflow] lease release failed', remoteRunId, error.message); }
      }
    }
}

async function runAgentChat(input) {
  if (engine.publicLicense().state !== 'authorized') throw new Error('请先登录并通过授权检查');
  const message = text(input?.message, 'message', 4000);
  const requestedPlatform = input?.platformAccountId == null || input.platformAccountId === ''
    ? currentPlatformAccountId
    : normalizePlatformAccountId(input.platformAccountId);
  if (!currentAccountUserId || !requestedPlatform) throw new Error('请先选择已授权的平台账号');
  if (!platformAccounts.some((account) => account.id === requestedPlatform)) throw new Error('目标平台账号不属于当前工作台或已停用');
  const accountId = registerWorkflowAccount(currentAccountUserId, requestedPlatform);
  const deviceId = authStore.getDevice().id;
  const requestKey = safeIdempotencyKey(typeof input?.idempotencyKey === 'string' && input.idempotencyKey.trim() ? input.idempotencyKey : `chat:${crypto.randomUUID()}`);
  const context = input?.context && typeof input.context === 'object' && !Array.isArray(input.context) ? input.context : {};

  return workflowManager.run(accountId, async ({ context: accountContext }) => {
    let plan = await accountContext.runtime.planFromIntent(message, context);
    // Intent planning only chooses a registered workflow. For reply-capable
    // workflows, a selected knowledge set must produce a second, server-issued
    // frozen reply plan before the executor is allowed to start. This keeps
    // vector retrieval/provider generation out of RUNNING and prevents the
    // planner from smuggling unsourced reply text into a fixed workflow.
    const replyWorkflow = ['comment.batch', 'comment.reply_then_private', 'live.batch', 'live.reply_then_private'].includes(plan.workflowId);
    const selectedKnowledgeSet = typeof context.knowledgeSetId === 'string' && context.knowledgeSetId.trim() ? context.knowledgeSetId.trim() : '';
    if (replyWorkflow && !selectedKnowledgeSet) throw new Error('评论和直播回复流程必须先选择租户话术库');
    if (replyWorkflow) {
      const replyPlan = await api.createReplyPlan({
        workflowId: plan.workflowId,
        version: plan.version,
        params: plan.params,
        knowledgeSetId: selectedKnowledgeSet,
        knowledgeSetVersion: context.knowledgeSetVersion,
        query: typeof context.knowledgeQuery === 'string' && context.knowledgeQuery.trim() ? context.knowledgeQuery : message,
        targets: Array.isArray(context.targets) ? context.targets.slice(0, 200) : [],
        idempotencyKey: safeIdempotencyKey(`reply-plan:${requestKey}:${plan.workflowId}:${plan.version}`)
      });
      if (replyPlan?.status !== 'issued' || !replyPlan.planId || !replyPlan.params) {
        const reason = replyPlan?.reason === 'KNOWLEDGE_NOT_FOUND' ? '话术库没有命中内容，已转人工' : '话术生成结果未被授权中心确认，已转人工';
        throw new Error(reason);
      }
      plan = { planId: replyPlan.planId, workflowId: replyPlan.workflowId, version: replyPlan.version, params: replyPlan.params };
    }
    return startWorkflowRun({ accountId, accountContext, plan, requestedPlatform, deviceId, chatMessage: message });
  }, { idempotencyKey: requestKey, metadata: { message, platformAccountId: requestedPlatform } });
}

async function prepareReplyPlan(input) {
  if (engine.publicLicense().state !== 'authorized') throw new Error('请先登录并通过授权检查');
  if (!api) throw new Error('授权中心尚未连接');
  const workflowId = text(input?.workflowId, 'workflow id', 100);
  const version = input?.version === undefined ? '1' : String(input.version);
  const knowledgeSetId = text(input?.knowledgeSetId, 'knowledge set id', 100);
  const query = text(input?.query, 'knowledge query', 4000);
  if (!workflowId || !knowledgeSetId || !query) throw new Error('生成话术前必须指定固定流程、话术库和问题');
  const request = {
    workflowId, version, params: input?.params && typeof input.params === 'object' ? input.params : {},
    knowledgeSetId, knowledgeSetVersion: input?.knowledgeSetVersion, query,
    topK: input?.topK, targets: Array.isArray(input?.targets) ? input.targets.slice(0, 200) : [],
    idempotencyKey: safeIdempotencyKey(typeof input?.idempotencyKey === 'string' && input.idempotencyKey.trim() ? input.idempotencyKey : `reply-plan:${workflowId}:${crypto.randomUUID()}`)
  };
  const requestEpoch = sessionEpoch; const requestApi = api; const requestToken = authStore.getToken();
  const result = await requestApi.createReplyPlan(request);
  if (requestEpoch !== sessionEpoch || requestApi !== api || authStore.getToken() !== requestToken) throw new Error('授权会话已切换，话术计划未应用');
  return result;
}


// 任务面板的结构化流程启动。
//
// 平台契约（server/src/workflow-routes.ts:375-389）：流程实例必须绑定服务端签发的计划，
// 客户端不能自己造 planId/params。所以这里做三件事：
//   1) 把结构化请求翻译成一句人话 + 结构化上下文，交给平台规划器；
//   2) 逐项核对平台返回的计划（workflowId / version / 请求里明确要求的 params）；
//   3) 核对通过才走与聊天完全相同的启动链路（目录校验 -> 建运行 -> 租约 -> 检查点 -> 结果决策）。
// 核对不过直接拒绝启动（fail-closed），绝不跑一个差不多的流程。
async function runExplicitWorkflow(input) {
  if (engine.publicLicense().state !== 'authorized') throw new Error('请先登录并通过授权检查');
  const request = workflowRequest.requestForWorkflow({
    workflowId: input?.workflowId,
    version: input?.version,
    params: input?.params
  });
  const requestedPlatform = input?.platformAccountId == null || input.platformAccountId === ''
    ? currentPlatformAccountId
    : normalizePlatformAccountId(input.platformAccountId);
  if (!currentAccountUserId || !requestedPlatform) throw new Error('请先选择已授权的平台账号');
  if (!platformAccounts.some((account) => account.id === requestedPlatform)) throw new Error('目标平台账号不属于当前工作台或已停用');
  const accountId = registerWorkflowAccount(currentAccountUserId, requestedPlatform);
  const deviceId = authStore.getDevice().id;
  const requestKey = safeIdempotencyKey(typeof input?.idempotencyKey === 'string' && input.idempotencyKey.trim()
    ? input.idempotencyKey
    : 'start:' + request.workflowId + ':' + requestedPlatform + ':' + crypto.randomUUID());
  const intent = workflowRequest.buildWorkflowIntent(request);
  const context = workflowRequest.buildWorkflowContext(request);
  return workflowManager.run(accountId, async ({ context: accountContext }) => {
    let plan;
    if (input?.replyPlan?.status === 'issued' && input.replyPlan.planId && input.replyPlan.params) {
      plan = { planId: input.replyPlan.planId, workflowId: input.replyPlan.workflowId, version: input.replyPlan.version, params: input.replyPlan.params };
      if (plan.workflowId !== request.workflowId || String(plan.version) !== String(request.version)) throw new Error('授权中心话术计划与请求流程不一致，已拒绝启动');
    } else if (['comment.batch', 'comment.reply_then_private', 'live.batch', 'live.reply_then_private'].includes(request.workflowId)) {
      const knowledgeSetId = typeof request.params.knowledgeSetId === 'string' ? request.params.knowledgeSetId.trim() : '';
      if (!knowledgeSetId) throw new Error('评论和直播回复流程必须先选择租户话术库');
      const replyPlan = await prepareReplyPlan({ workflowId: request.workflowId, version: request.version, params: request.params, knowledgeSetId, query: request.params.keywords.join('、') });
      if (replyPlan?.status !== 'issued' || !replyPlan.planId || !replyPlan.params) throw new Error(replyPlan?.status === 'UNKNOWN' ? '话术生成结果未知，请先查询原幂等请求' : '授权中心未签发冻结话术计划');
      plan = { planId: replyPlan.planId, workflowId: replyPlan.workflowId, version: replyPlan.version, params: replyPlan.params };
    } else {
      plan = await accountContext.runtime.planFromIntent(intent, context);
      const check = workflowRequest.planMatchesRequest(plan, request);
      if (!check.ok) throw new Error('平台返回的计划与请求不一致（' + check.reason + (check.field ? '/' + check.field : '') + '），已拒绝启动');
    }
    return startWorkflowRun({ accountId, accountContext, plan, requestedPlatform, deviceId });
  }, { idempotencyKey: requestKey, metadata: { workflowId: request.workflowId, platformAccountId: requestedPlatform } });
}

function registerIpc() {
  const wrap = (handler) => async (event, payload) => { assertLocalSender(event); return handler(event, payload); };
  const authorizedApiCall = async (operation) => {
    if (engine.publicLicense().state !== 'authorized') throw new Error('请先登录并通过授权检查');
    const requestEpoch = sessionEpoch;
    const requestApi = api;
    const requestToken = authStore.getToken();
    if (!requestApi || !requestToken) throw new Error('请先登录并通过授权检查');
    const result = await operation(requestApi, requestToken);
    if (requestEpoch !== sessionEpoch || requestApi !== api || authStore.getToken() !== requestToken) throw new Error('授权会话已切换，结果未应用');
    return result;
  };
  ipcMain.handle('agent:get-state', wrap(() => ({ ...engine.snapshot(), browser: browserState, workflow: workflowRuntime?.snapshot() || { accountId: runtimeAccountId(currentAccountUserId, currentPlatformAccountId), runs: [] }, workflowAccounts: [...workflowAccountRuns.values()], platformAccounts, platformAccountId: currentPlatformAccountId })));
  ipcMain.handle('agent:list-workflows', wrap(() => workflowRuntime.listWorkflows()));
  ipcMain.handle('platform-accounts:list', wrap(() => listPlatformAccounts()));
  ipcMain.handle('platform-accounts:select', wrap((_event, platformId) => switchPlatformAccount(platformId)));
  ipcMain.handle('platform-accounts:create', wrap((_event, input) => createPlatformAccount(input)));
  ipcMain.handle('agent:chat', wrap((_event, input) => runAgentChat(input)));
  ipcMain.handle('agent:prepare-reply-plan', wrap((_event, input) => prepareReplyPlan(input)));
  ipcMain.handle('agent:start-workflow', wrap((_event, input) => runExplicitWorkflow(input)));
  ipcMain.handle('agent:resume-workflow', wrap(async (_event, input) => {
    const runId = typeof input === 'string' ? input : input?.runId;
    const requestedPlatform = typeof input === 'object' && input?.platformAccountId ? normalizePlatformAccountId(input.platformAccountId) : currentPlatformAccountId;
    if (!requestedPlatform || !platformAccounts.some((account) => account.id === requestedPlatform)) throw new Error('目标平台账号不属于当前工作台或已停用');
    const accountId = registerWorkflowAccount(currentAccountUserId, requestedPlatform);
    const normalizedRunId = text(runId, 'run id', 160);
    const deviceId = authStore.getDevice().id;
    return workflowManager.run(accountId, async ({ context: accountContext }) => {
      const runtime = accountContext.runtime;
      let local;
      try {
        local = runtime.getRun(normalizedRunId);
      } catch (error) {
        throw new Error(`当前选中的平台账号没有该流程，已拒绝恢复：${error.message}`);
      }
      if (!local.remoteRunId) {
        // A timeout after the server committed the idempotent create can leave
        // the local checkpoint without the remote id. Reconcile by the
        // server-issued plan id; never execute an unbound local run.
        const remoteRows = await api.workflowRuns();
        const candidate = (Array.isArray(remoteRows?.runs) ? remoteRows.runs : []).find((item) => item.planId === local.plan?.planId && item.platformAccountId === requestedPlatform && !['COMPLETED', 'FAILED', 'STOPPED'].includes(item.status));
        if (!candidate?.id) throw new Error('该流程缺少授权端运行实例，已拒绝恢复；请重新创建任务');
        runtime.attachRemoteRun(local.runId, candidate.id);
        local = runtime.getRun(normalizedRunId);
      }
      let remoteVersion = null;
      let leaseHeld = false;
      let reconciledProof = null;
      let leaseHeartbeat = null;
      try {
        if (local.remoteRunId) {
          await api.acquireWorkflowLease(local.remoteRunId, { ttlMs: 120000, idempotencyKey: safeIdempotencyKey(`lease:acquire:${local.remoteRunId}:${accountId}:${local.runId}:${deviceId}`) });
          leaseHeld = true;
        }
        if (local.status === 'UNKNOWN' && local.remoteRunId) {
          const remoteState = await api.workflowRun(local.remoteRunId);
          reconciledProof = remoteState?.run?.checkpoint?.targetState?.reconciliationProof || null;
          if (typeof reconciledProof !== 'string' || !reconciledProof) throw new Error('副作用结果未知，授权端尚未签发恢复核验凭证');
        }
        const health = await runtime.checkHealth(local.runId);
        if (local.remoteRunId) {
          const recovered = await api.recoverWorkflow(local.remoteRunId, { checksPassed: health.checksPassed, userConfirmed: true, reason: 'desktop_manual_resume', idempotencyKey: safeIdempotencyKey(`recover:${local.remoteRunId}:${local.status}:${reconciledProof || 'none'}`), ...(reconciledProof ? { reconciledProof } : {}) });
          remoteVersion = Number.isSafeInteger(recovered?.run?.checkpointVersion) ? recovered.run.checkpointVersion : null;
          leaseHeartbeat = startLeaseHeartbeat(local.remoteRunId, accountId, deviceId);
        }
        const result = await runtime.resumeRun(local.runId, { skipHealthCheck: true, ...(reconciledProof ? { reconciledProof } : {}) });
        leaseHeartbeat?.assertHealthy();
        workflowAccountRuns.set(accountId, { accountId, platformAccountId: requestedPlatform, run: result });
        const sendWorkflow = local.steps.some((step) => step && step.sideEffect === true);
        const sendEvidenceMissing = result.status === 'COMPLETED' && sendWorkflow;
        const reportedStatus = sendEvidenceMissing ? 'WAITING_HUMAN' : result.status;
        const reportedCheckpoint = sendEvidenceMissing
          ? { ...(result.checkpoint || {}), phase: 'send', reason: 'server_send_evidence_required' }
          : (result.checkpoint || {});
        if (local.remoteRunId && remoteVersion != null) {
          await api.renewWorkflowLease(local.remoteRunId, { ttlMs: 120000, idempotencyKey: safeIdempotencyKey(`lease:renew:${local.remoteRunId}:${result.runId}:${result.status}:${deviceId}`) });
          const checkpoint = await api.checkpointWorkflow(local.remoteRunId, { status: reportedStatus, stepId: String(result.currentStep), expectedVersion: remoteVersion, idempotencyKey: checkpointIdempotencyKey(local.remoteRunId, reportedStatus, remoteVersion, String(result.currentStep), 'resume-result'), failure: sendEvidenceMissing ? { code: 'SEND_EVIDENCE_REQUIRED', message: '平台未提供授权端可验证的送达证据' } : (result.lastError || undefined), targetState: reportedCheckpoint, humanWait: reportedStatus === 'WAITING_HUMAN' ? { reason: sendEvidenceMissing ? '平台送达证据未验证，需人工检查' : (result.lastError?.message || '平台适配器需要人工处理'), context: reportedCheckpoint } : undefined });
          remoteVersion = Number.isSafeInteger(checkpoint?.run?.checkpointVersion) ? checkpoint.run.checkpointVersion : remoteVersion + 1;
        }
        const nextDecision = sendEvidenceMissing ? { decision: 'wait_human', reason: 'server_send_evidence_required' } : await requestResultDecision(local.remoteRunId, result);
        leaseHeartbeat?.assertHealthy();
        const applied = await applyResultDecisionAndCompose({ runtime, accountId, accountContext, requestedPlatform, deviceId, result, nextDecision });
        const decisionApplied = applied.decisionApplied;
        emitState(); return { ...(decisionApplied?.run || result), nextDecision, decisionApplied, nextRun: applied.nextRun };
      } catch (error) {
        if (leaseHeld) await solidifyRemoteWorkflow(local.remoteRunId, error.message, local, { accountId, deviceId });
        throw error;
      } finally {
        leaseHeartbeat?.stop();
        if (leaseHeld) {
          try { await api.releaseWorkflowLease(local.remoteRunId, { idempotencyKey: safeIdempotencyKey(`lease:release:${local.remoteRunId}:${local.runId}:${deviceId}`) }); } catch (error) { console.warn('[workflow] lease release failed', local.remoteRunId, error.message); }
        }
      }
    }, { taskId: `resume:${normalizedRunId}`, metadata: { platformAccountId: requestedPlatform } });
  }));
  ipcMain.handle('agent:retry-result-decision', wrap(async (_event, input) => {
    if (engine.publicLicense().state !== 'authorized') throw new Error('请先登录并通过授权检查');
    const runId = text(typeof input === 'string' ? input : input?.runId, 'run id', 160);
    const requestedPlatform = typeof input === 'object' && input?.platformAccountId ? normalizePlatformAccountId(input.platformAccountId) : currentPlatformAccountId;
    if (!runId || !requestedPlatform || !currentAccountUserId || !platformAccounts.some((account) => account.id === requestedPlatform)) throw new Error('结果决策重试缺少有效的账号或流程');
    const accountId = registerWorkflowAccount(currentAccountUserId, requestedPlatform);
    return workflowManager.run(accountId, async ({ context: accountContext }) => {
      const runtime = accountContext.runtime;
      const local = runtime.getRun(runId);
      if (!local.remoteRunId || local.status !== 'COMPLETED') throw new Error('只有已完成且结果决策未结算的流程可以重试结果决策');
      const nextDecision = await requestResultDecision(local.remoteRunId, local);
      const applied = await applyResultDecisionAndCompose({ runtime, accountId, accountContext, requestedPlatform, deviceId: authStore.getDevice().id, result: local, nextDecision });
      const displayRun = applied.decisionApplied?.run || local;
      workflowAccountRuns.set(accountId, { accountId, platformAccountId: requestedPlatform, run: displayRun });
      emitState();
      return { run: displayRun, nextDecision, decisionApplied: applied.decisionApplied, nextRun: applied.nextRun };
    }, { taskId: `result-decision:${runId}`, metadata: { platformAccountId: requestedPlatform } });
  }));
  ipcMain.handle('agent:manual-complete-workflow', wrap(async (_event, input) => {
    if (engine.publicLicense().state !== 'authorized') throw new Error('请先登录并通过授权检查');
    const runId = text(typeof input === 'string' ? input : input?.runId, 'run id', 160);
    const note = typeof input === 'object' && typeof input?.note === 'string' ? input.note.slice(0, 500) : '';
    const requestedPlatform = typeof input === 'object' && input?.platformAccountId ? normalizePlatformAccountId(input.platformAccountId) : currentPlatformAccountId;
    if (!runId || !requestedPlatform || !currentAccountUserId || !platformAccounts.some((account) => account.id === requestedPlatform)) throw new Error('人工确认缺少有效的账号或流程');
    const accountId = registerWorkflowAccount(currentAccountUserId, requestedPlatform);
    const deviceId = authStore.getDevice().id;
    return workflowManager.run(accountId, async ({ context: accountContext }) => {
      const runtime = accountContext.runtime; const local = runtime.getRun(runId);
      if (!local.remoteRunId) throw new Error('该流程尚未绑定授权端运行实例，无法人工确认');
      let leaseHeld = false;
      try {
        await api.acquireWorkflowLease(local.remoteRunId, { ttlMs: 120000, idempotencyKey: safeIdempotencyKey(`lease:manual-complete:${local.remoteRunId}:${deviceId}`) });
        leaseHeld = true;
        const response = await api.manualCompleteWorkflow(local.remoteRunId, { note, idempotencyKey: safeIdempotencyKey(typeof input === 'object' && input?.idempotencyKey ? input.idempotencyKey : `manual-complete:${local.remoteRunId}`) });
        const proofId = text(response?.proofId, 'manual proof id', 180);
        if (!proofId) throw new Error('授权端未返回人工确认凭证');
        const result = runtime.manualComplete(runId, proofId);
        workflowAccountRuns.set(accountId, { accountId, platformAccountId: requestedPlatform, run: result });
        emitState();
        return result;
      } finally {
        if (leaseHeld) {
          try { await api.releaseWorkflowLease(local.remoteRunId, { idempotencyKey: safeIdempotencyKey(`lease:release-manual-complete:${local.remoteRunId}:${deviceId}`) }); } catch (error) { console.warn('[workflow] manual completion lease release failed', error.message); }
        }
      }
    }, { taskId: `manual-complete:${runId}`, metadata: { platformAccountId: requestedPlatform } });
  }));
  ipcMain.handle('agent:pause-workflow', wrap(async (_event, runId) => {
    const accountId = registerWorkflowAccount(currentAccountUserId, currentPlatformAccountId);
    const context = await workflowManager.getContext(accountId);
    const result = context.runtime.pauseRun(text(runId, 'run id', 160));
    emitState(); return result;
  }));
  ipcMain.handle('agent:login', wrap(handleLogin));
  ipcMain.handle('agent:logout', wrap(handleLogout));
  ipcMain.handle('agent:refresh-license', wrap(() => refreshLicense()));
  ipcMain.handle('agent:get-endpoint', wrap(() => ({ apiEndpoint })));
  ipcMain.handle('agent:set-endpoint', wrap(configureEndpoint));
  ipcMain.handle('task:save', wrap((_event, task) => engine.saveTask(task)));
  ipcMain.handle('task:set-status', wrap((_event, input) => engine.setTaskStatus(text(input?.id, 'task id', 100), input.status)));
  ipcMain.handle('task:recheck-skipped', wrap((_event, taskId) => engine.recheckSkipped(text(taskId, 'task id', 100))));
  ipcMain.handle('task:delete', wrap((_event, id) => engine.deleteTask(text(id, 'task id', 100))));
  ipcMain.handle('reply:confirm', wrap((_event, actionId) => engine.confirmAction(text(actionId, 'action id', 160))));
  ipcMain.handle('reply:retry-draft', wrap((_event, eventKey) => engine.retryDraft(text(eventKey, 'event key', 240))));
  ipcMain.handle('credits:redeem', wrap(handleRedeem));
  ipcMain.handle('credits:ledger', wrap(async () => { if (!authStore.getToken()) throw new Error('请先登录'); const requestEpoch = sessionEpoch; const requestApi = api; const requestToken = authStore.getToken(); const result = await requestApi.ledger(requestToken); if (requestEpoch !== sessionEpoch || requestApi !== api || authStore.getToken() !== requestToken) throw new Error('授权会话已切换，台账未应用'); return Array.isArray(result) ? result : result.entries || result.ledger || result.items || []; }));
  ipcMain.handle('knowledge:list-sets', wrap(() => authorizedApiCall((requestApi, token) => requestApi.knowledgeSets(token))));
  ipcMain.handle('knowledge:create-set', wrap((_event, input) => authorizedApiCall((requestApi, token) => requestApi.createKnowledgeSet({ name: text(input?.name, 'knowledge set name', 100), description: typeof input?.description === 'string' ? input.description : '' }, token))));
  ipcMain.handle('knowledge:list-documents', wrap((_event, input) => authorizedApiCall((requestApi, token) => requestApi.knowledgeDocuments(text(input?.knowledgeSetId, 'knowledge set id', 100), token))));
  ipcMain.handle('knowledge:add-document', wrap((_event, input) => authorizedApiCall((requestApi, token) => requestApi.addKnowledgeDocument({ knowledgeSetId: text(input?.knowledgeSetId, 'knowledge set id', 100), title: text(input?.title, 'document title', 300), content: text(input?.content, 'document content', 200000), metadata: input?.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {} }, token))));
  ipcMain.handle('knowledge:retrieve', wrap((_event, input) => authorizedApiCall((requestApi, token) => requestApi.retrieveKnowledge({ knowledgeSetId: text(input?.knowledgeSetId, 'knowledge set id', 100), query: text(input?.query, 'knowledge query', 4000), topK: Number(input?.topK || 5) }, token))));
  ipcMain.handle('browser:open', wrap(async (_event, url) => { if (engine.publicLicense().state !== 'authorized') throw new Error('请先登录并通过授权检查'); const requestEpoch = sessionEpoch; const requestBrowser = browser; const requested = targetUrl(url); engine.pauseAll('browser_navigation'); const finalUrl = await requestBrowser.open(requested); if (requestEpoch !== sessionEpoch || requestBrowser !== browser) throw new Error('授权会话已切换，页面结果已丢弃'); if (finalUrl && finalUrl !== requested) dataStore.update((data) => ({ ...data, tasks: data.tasks.map((task) => task.url === requested ? { ...task, url: finalUrl, updatedAt: new Date().toISOString() } : task) })); return browserState; }));
  ipcMain.handle('browser:search', wrap(async (_event, input) => { const license = engine.publicLicense(); if (license.state !== 'authorized') throw new Error('请先登录并通过授权检查'); if (license.features?.videoSearch !== true) throw new Error('当前授权未开通找视频功能'); const requestEpoch = sessionEpoch; const requestBrowser = browser; const result = await requestBrowser.search({ keyword: text(input?.keyword, 'keyword', 200), maxVideos: Number(input?.maxVideos || 20), scrollRounds: Number(input?.scrollRounds || 2), cursor: input?.cursor || undefined, minRelevance: Number(input?.minRelevance || 0) }); if (requestEpoch !== sessionEpoch || requestBrowser !== browser) throw new Error('授权会话已切换，搜索结果已丢弃'); return result; }));
  ipcMain.handle('browser:search-pool', wrap(async (_event, input) => { const license = engine.publicLicense(); if (license.state !== 'authorized') throw new Error('请先登录并通过授权检查'); if (license.features?.videoSearch !== true) throw new Error('当前授权未开通找视频功能'); const requestEpoch = sessionEpoch; const requestBrowser = browser; if (typeof requestBrowser.searchPool !== 'function') throw new Error('当前侧车未提供搜索池'); const result = await requestBrowser.searchPool({ keyword: input?.keyword ? text(input.keyword, 'keyword', 200) : undefined, limit: Number(input?.limit || 200), minRelevance: Number(input?.minRelevance || 0) }); if (requestEpoch !== sessionEpoch || requestBrowser !== browser) throw new Error('授权会话已切换，搜索池结果已丢弃'); return result; }));
  ipcMain.handle('browser:close', wrap(() => browser.close()));
  ipcMain.handle('selectors:probe', wrap(async (_event, profile) => {
    const normalized = normalizeProfile(profile || currentProfile());
    const result = await browser.probe(normalized);
    lastProbe = { profile: normalized, result, at: Date.now() };
    return result;
  }));
  ipcMain.handle('selectors:save', wrap((_event, profile) => {
    if (browser?.isSidecar) throw new Error('当前使用外部专用 Chrome，CSS 校准仅用于 Electron 离线回退；请先完成侧车能力探测');
    const normalized = normalizeProfile(profile || currentProfile());
    const probe = lastProbe && JSON.stringify(lastProbe.profile) === JSON.stringify(normalized) ? lastProbe.result : null;
    const activeTask = dataStore.get().tasks.find((task) => task.status === 'running') || dataStore.get().tasks[0];
    const source = activeTask?.source || 'video';
    if (!probe || Number(probe.commentNode) < 1 || Number(probe.replyInput) < 1 || Number(probe.sendButton) < 1 || (source === 'video' && Number(probe.replyButton) < 1)) throw new Error('请先校准可见评论节点、回复输入框和发送按钮；视频评论还需要评论行回复按钮');
    const saved = { ...normalized, id: normalized.id || `profile_${crypto.randomUUID()}`, verified: true, verifiedAt: new Date().toISOString(), source: '用户在目标页面校准，主进程记录可见匹配数', calibration: { ...probe, source, targetUrl: activeTask?.url || null } };
    dataStore.update((data) => ({ ...data, selectorProfile: saved }));
    engine.selectorProfile = saved;
    emitState();
    return saved;
  }));
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    title: '截流自动回复 Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  uiFrameUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function boot() {
  const userData = app.getPath('userData');
  authStore = new AuthStore(userData, require('electron').safeStorage);
  const configuredEndpoint = authStore.store.get().endpoint || process.env.DOUYIN_LICENSE_API || 'http://127.0.0.1:18080';
  apiEndpoint = validateEndpoint(configuredEndpoint);
  if (authStore.store.get().endpoint && authStore.store.get().endpoint !== apiEndpoint) authStore.clear();
  authStore.setEndpoint(apiEndpoint);
  api = new ApiClient({ baseUrl: apiEndpoint, authStore });
  workflowManager = new AccountRuntimeManager({
    contextFactory: ({ accountId, options }) => {
      const userId = options?.workbenchUserId;
      const platformAccount = options?.platformAccountId;
      if (!userId || !platformAccount || accountId !== runtimeAccountId(userId, platformAccount)) throw new Error('工作流账号上下文范围无效');
      const store = new JsonStore(accountDataPath(userId, platformAccount), defaultData);
      let runtime;
      const accountBrowser = createBrowserInstance(userId, platformAccount, {
        onStatus: (status) => pauseWorkflowForBrowserStatus(accountId, runtime, status)
      });
      runtime = createWorkflowRuntimeForStore(store, userId, platformAccount, accountBrowser);
      return {
        accountId,
        store,
        runtime,
        invalidate: (reason) => { runtime.invalidate(reason); accountBrowser.stop?.(); },
        close: () => accountBrowser.close()
      };
    }
  });
  // Read the encrypted token before clearing the cached display license. This
  // keeps startup fail-closed while avoiding a second decryption during the
  // first heartbeat on platforms whose credential backend initializes lazily.
  const startupToken = authStore.getToken();
  // A cached license is only a display hint.  Do not expose it as authorized
  // before the first online /me check; keep the encrypted token for recovery.
  authStore.setLicense(null);
  dataStore = new JsonStore(accountDataPath(null, null), defaultData);
  await createBrowser(null);
  createEngineForStore(dataStore, null);
  registerIpc();
  await createMainWindow();
  browser.parentWindow = mainWindow;
  if (startupToken) void refreshLicense(startupToken).catch((error) => console.warn('[auth] initial license refresh failed', error.message));
  setInterval(() => { if (authStore.getToken()) void refreshLicense().catch((error) => console.warn('[auth] heartbeat failed', error.message)); }, 30000);
  emitState();
}

app.whenReady().then(() => { if (hasSingleInstanceLock) return boot(); return undefined; }).catch((error) => {
  console.error('[desktop] boot failed', error);
  dialog.showErrorBox('截流 Agent 无法启动', error.message);
  app.quit();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  const deadline = setTimeout(() => app.quit(), 8000);
  deadline.unref?.();
  Promise.all([
    Promise.resolve(workflowManager?.close?.()).catch((error) => console.warn('[desktop] workflow manager close failed', error.message)),
    Promise.resolve(browser?.close?.()).catch((error) => console.warn('[desktop] browser close failed', error.message))
  ]).finally(() => {
    clearTimeout(deadline);
    app.quit();
  });
});

module.exports = { isAllowedUrl };
