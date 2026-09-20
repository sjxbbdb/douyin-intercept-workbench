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
const { platformWorkflowDefinitions } = require('./lib/workflow-contracts');
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
  return scopedSidecarPort(apiEndpoint, userId || 'guest', platformAccount);
}

function runtimeAccountId(userId, platformAccount) {
  return platformScope({ workbenchUserId: userId || 'guest', platformAccountId: platformAccount }).runtimeAccountId;
}

function createBrowserInstance(userId, platformAccount = currentPlatformAccountId, callbacks = {}) {
  const common = { onStatus: callbacks.onStatus || (() => {}), onEvents: callbacks.onEvents || (() => {}) };
  return process.env.DOUYIN_ELECTRON_BRIDGE === '1'
    ? new BrowserBridge({ parentWindow: mainWindow, getPartition: () => browserPartition(apiEndpoint, userId || 'guest', platformAccount), ...common })
    : new ProbeBridge({ accountDir: accountDir(userId, platformAccount), port: sidecarPort(userId, platformAccount), cwd: path.resolve(__dirname, '..', '..'), resourcesPath: process.resourcesPath, packaged: app.isPackaged, ...common });
}

async function createBrowser(userId, platformAccount = currentPlatformAccountId) {
  const previous = browser;
  browser = null;
  if (previous) await previous.close?.();
  const callbackEpoch = sessionEpoch;
  browser = createBrowserInstance(userId, platformAccount, {
    onStatus: (status) => { if (callbackEpoch !== sessionEpoch) return; if (status.navigating) engine?.pauseAll('browser_navigation'); if (['captcha', 'login_required', 'unsupported'].includes(status.status)) engine?.pauseAll(`sidecar_${status.status}`); browserState = { ...browserState, ...status }; emitState(); },
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
    browserState = { connected: false, collector: 'closed', matchCount: 0 };
    lastProbe = null;
    engine?.invalidate(reason);
    workflowRuntime?.invalidate(reason);
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

async function requestResultDecision(remoteRunId, result) {
  if (!remoteRunId || !result || result.status === 'RUNNING') return null;
  if (typeof api?.resultDecision !== 'function') return { state: 'unavailable', reason: 'result_decision_api_unavailable', requiresManualGate: true };
  const idempotencyKey = safeIdempotencyKey(`result:${remoteRunId}:${result.status}:${result.currentStep ?? 'final'}`);
  try {
    const response = await api.resultDecision(remoteRunId, { status: result.status, summary: { currentStep: result.currentStep, checkpoint: result.checkpoint || null, failure: result.lastError || null }, idempotencyKey });
    return { ...response, requiresManualGate: result.status === 'UNKNOWN' || result.status === 'WAITING_HUMAN' };
  } catch (error) {
    return { state: 'unavailable', code: error.code || 'RESULT_DECISION_FAILED', reason: error.message, requiresManualGate: true };
  }
}

async function solidifyRemoteWorkflow(remoteRunId, reason) {
  if (!remoteRunId || typeof api?.workflowRun !== 'function') return;
  try {
    const remote = await api.workflowRun(remoteRunId);
    if (remote?.run?.status !== 'RUNNING') return;
    await api.checkpointWorkflow(remoteRunId, {
      status: 'WAITING_HUMAN',
      stepId: String(remote.run.currentStep ?? 0),
      expectedVersion: remote.run.checkpointVersion,
      humanWait: { reason: String(reason || '桌面端流程异常，等待人工核对'), context: { source: 'desktop_platform' } },
      failure: { code: 'DESKTOP_WORKFLOW_INTERRUPTED', message: String(reason || '桌面端流程异常') }
    });
  } catch (error) {
    console.warn('[workflow] failed to solidify remote run', remoteRunId, error.message);
  }
}

function currentProfile() { return dataStore.get().selectorProfile || DEFAULT_SELECTOR_PROFILE; }

function normalizedPlatformAccounts(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.accounts;
  if (!Array.isArray(rows)) throw new Error('授权中心返回的平台账号列表无效');
  return rows.filter((item) => item && typeof item.id === 'string' && item.id.trim() && item.status !== 'disabled').map((item) => ({ ...item, id: normalizePlatformAccountId(item.id) }));
}

async function fetchPlatformAccounts(requestApi = api, tokenOverride = null) {
  const response = await requestApi.platformAccounts(tokenOverride || authStore.getToken());
  return normalizedPlatformAccounts(response);
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
    const accounts = await fetchPlatformAccounts(requestApi, requestToken);
    const selected = preferredPlatformAccount(safe.user.id, accounts);
    const currentStillValid = currentPlatformAccountId && accounts.some((item) => item.id === currentPlatformAccountId);
    const needsAccountSwitch = currentAccountUserId !== safe.user.id
      || (!currentStillValid && selected !== currentPlatformAccountId && selected != null);
    if (needsAccountSwitch) {
      if (currentAccountUserId !== safe.user.id) invalidateManagedWorkflows('workbench_account_switch');
      const switched = await switchAccountStore(safe.user.id, 'account_switch_from_refresh', () => requestApi === api && authStore.getToken() === requestToken, selected);
      if (!switched) return { state: 'stale' };
      if (selected) authStore.setPlatformAccountId(safe.user.id, selected);
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
    const runtime = accountContext.runtime;
    const plan = await runtime.planFromIntent(message, context);
    const catalogResponse = await api.workflows();
    const catalog = Array.isArray(catalogResponse?.workflows) ? catalogResponse.workflows : [];
    const registered = catalog.find((item) => item.workflowId === plan.workflowId && String(item.version) === String(plan.version) && item.status === 'active');
    if (!registered) throw new Error('授权中心未开放该固定流程');
    const canonical = PLATFORM_WORKFLOWS.find((item) => item.workflowId === registered.workflowId && String(item.version) === String(registered.version));
    const contractSteps = canonical?.steps || (Array.isArray(registered.contract?.steps) ? registered.contract.steps : []);
    if (!contractSteps.length) throw new Error('授权中心返回的固定流程没有可执行步骤');
    runtime.registerWorkflow({ workflowId: registered.workflowId, version: String(registered.version), steps: contractSteps });
    const remote = await api.createWorkflowRun({ planId: plan.planId, workflowId: plan.workflowId, version: plan.version, params: plan.params, platformAccountId: requestedPlatform, knowledgeSetId: typeof plan.params.knowledgeSetId === 'string' ? plan.params.knowledgeSetId : undefined, idempotencyKey: safeIdempotencyKey(`run:${plan.planId}:${requestedPlatform}`) });
    const remoteRunId = remote?.run?.id;
    if (!remoteRunId) throw new Error('授权中心未返回流程实例');
    let leaseHeld = false;
    let remoteVersion = Number.isSafeInteger(remote?.run?.checkpointVersion) ? remote.run.checkpointVersion : 0;
    try {
      await api.acquireWorkflowLease(remoteRunId, { ttlMs: 120000, idempotencyKey: safeIdempotencyKey(`lease:acquire:${remoteRunId}:${accountId}:${deviceId}`) });
      leaseHeld = true;
      const running = await api.checkpointWorkflow(remoteRunId, { status: 'RUNNING', expectedVersion: remoteVersion });
      remoteVersion = Number.isSafeInteger(running?.run?.checkpointVersion) ? running.run.checkpointVersion : remoteVersion + 1;
      const run = runtime.startPlan(plan);
      workflowAccountRuns.set(accountId, { accountId, platformAccountId: requestedPlatform, run: { ...run, status: 'RUNNING' } });
      emitState();
      accountContext.store.update((data) => ({ ...data, workflowRuns: data.workflowRuns.map((candidate) => candidate.runId === run.runId ? { ...candidate, remoteRunId } : candidate) }));
      const result = await runtime.run(run.runId);
      workflowAccountRuns.set(accountId, { accountId, platformAccountId: requestedPlatform, run: result });
      await api.renewWorkflowLease(remoteRunId, { ttlMs: 120000, idempotencyKey: safeIdempotencyKey(`lease:renew:${remoteRunId}:${result.runId}:${result.status}:${deviceId}`) });
      const finalRemote = await api.checkpointWorkflow(remoteRunId, { status: result.status, stepId: String(result.currentStep), expectedVersion: remoteVersion, failure: result.lastError || undefined, targetState: result.checkpoint || {}, humanWait: result.status === 'WAITING_HUMAN' ? { reason: result.lastError?.message || '平台适配器需要人工处理', context: result.checkpoint || {} } : undefined });
      remoteVersion = Number.isSafeInteger(finalRemote?.run?.checkpointVersion) ? finalRemote.run.checkpointVersion : remoteVersion + 1;
      const nextDecision = await requestResultDecision(remoteRunId, result);
      let decisionApplied = null;
      if (nextDecision?.decision === 'wait_human' && ['UNKNOWN', 'CHECKPOINT', 'WAITING_HUMAN', 'PAUSED'].includes(result.status)) {
        decisionApplied = runtime.applyResultDecision(result.runId, 'wait_human', { reason: 'server_result_decision', checkpoint: result.checkpoint || null });
        if (result.status !== 'WAITING_HUMAN') {
          const humanCheckpoint = await api.checkpointWorkflow(remoteRunId, { status: 'WAITING_HUMAN', stepId: String(result.currentStep), expectedVersion: remoteVersion, humanWait: { reason: 'Agent 结果决策要求人工处理', context: result.checkpoint || {} }, failure: result.lastError || undefined, targetState: result.checkpoint || {} });
          remoteVersion = Number.isSafeInteger(humanCheckpoint?.run?.checkpointVersion) ? humanCheckpoint.run.checkpointVersion : remoteVersion + 1;
        }
      } else if (nextDecision?.decision && result.status === 'COMPLETED' && ['continue', 'complete'].includes(nextDecision.decision)) {
        decisionApplied = runtime.applyResultDecision(result.runId, nextDecision.decision, { reason: 'server_result_decision' });
      } else if (nextDecision?.decision) {
        decisionApplied = { action: 'suggested', decision: nextDecision.decision, requiresManualGate: true };
      }
      const displayRun = decisionApplied?.run || result;
      workflowAccountRuns.set(accountId, { accountId, platformAccountId: requestedPlatform, run: displayRun });
      const searchResult = displayRun.steps?.find((step) => step.stepId === 'search')?.result;
      const searchHint = searchResult?.kind === 'video_search'
        ? `；找到 ${searchResult.videos?.length || 0} 个候选视频${(searchResult.videos || []).slice(0, 3).map((video) => `\n${video.title || video.url}`).join('')}`
        : '';
      const humanHint = displayRun.status === 'UNKNOWN' || displayRun.status === 'WAITING_HUMAN' || decisionApplied?.requiresManualGate ? '；需要人工处理后再继续' : '';
      const decisionHint = nextDecision?.decision ? `；结果决策：${nextDecision.decision}` : '';
      accountContext.store.update((data) => ({ ...data, chat: [...(Array.isArray(data.chat) ? data.chat : []), { role: 'user', content: message, at: new Date().toISOString() }, { role: 'assistant', content: `已选择固定流程 ${plan.workflowId}@${plan.version}，当前状态：${displayRun.status}${searchHint}${humanHint}${decisionHint}`, runId: result.runId, at: new Date().toISOString() }].slice(-100) }));
      emitState();
      return { plan, run: displayRun, nextDecision, decisionApplied };
    } catch (error) {
      if (leaseHeld) await solidifyRemoteWorkflow(remoteRunId, error.message);
      throw error;
    } finally {
      if (leaseHeld) {
        try { await api.releaseWorkflowLease(remoteRunId, { idempotencyKey: safeIdempotencyKey(`lease:release:${remoteRunId}:${accountId}:${deviceId}`) }); } catch (error) { console.warn('[workflow] lease release failed', remoteRunId, error.message); }
      }
    }
  }, { idempotencyKey: requestKey, metadata: { message, platformAccountId: requestedPlatform } });
}

function registerIpc() {
  const wrap = (handler) => async (event, payload) => { assertLocalSender(event); return handler(event, payload); };
  ipcMain.handle('agent:get-state', wrap(() => ({ ...engine.snapshot(), browser: browserState, workflow: workflowRuntime?.snapshot() || { accountId: runtimeAccountId(currentAccountUserId, currentPlatformAccountId), runs: [] }, workflowAccounts: [...workflowAccountRuns.values()], platformAccounts, platformAccountId: currentPlatformAccountId })));
  ipcMain.handle('agent:list-workflows', wrap(() => workflowRuntime.listWorkflows()));
  ipcMain.handle('platform-accounts:list', wrap(() => listPlatformAccounts()));
  ipcMain.handle('platform-accounts:select', wrap((_event, platformId) => switchPlatformAccount(platformId)));
  ipcMain.handle('platform-accounts:create', wrap((_event, input) => createPlatformAccount(input)));
  ipcMain.handle('agent:chat', wrap((_event, input) => runAgentChat(input)));
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
      let remoteVersion = null;
      let leaseHeld = false;
      try {
        if (local.remoteRunId) {
          await api.acquireWorkflowLease(local.remoteRunId, { ttlMs: 120000, idempotencyKey: safeIdempotencyKey(`lease:acquire:${local.remoteRunId}:${accountId}:${local.runId}:${deviceId}`) });
          leaseHeld = true;
        }
        const health = await runtime.checkHealth(local.runId);
        if (local.remoteRunId) {
          const recovered = await api.recoverWorkflow(local.remoteRunId, { checksPassed: health.checksPassed, userConfirmed: true, reason: 'desktop_manual_resume' });
          remoteVersion = Number.isSafeInteger(recovered?.run?.checkpointVersion) ? recovered.run.checkpointVersion : null;
        }
        const result = await runtime.resumeRun(local.runId, { skipHealthCheck: true });
        workflowAccountRuns.set(accountId, { accountId, platformAccountId: requestedPlatform, run: result });
        if (local.remoteRunId && remoteVersion != null) {
          await api.renewWorkflowLease(local.remoteRunId, { ttlMs: 120000, idempotencyKey: safeIdempotencyKey(`lease:renew:${local.remoteRunId}:${result.runId}:${result.status}:${deviceId}`) });
          const checkpoint = await api.checkpointWorkflow(local.remoteRunId, { status: result.status, stepId: String(result.currentStep), expectedVersion: remoteVersion, failure: result.lastError || undefined, targetState: result.checkpoint || {}, humanWait: result.status === 'WAITING_HUMAN' ? { reason: result.lastError?.message || '平台适配器需要人工处理', context: result.checkpoint || {} } : undefined });
          remoteVersion = Number.isSafeInteger(checkpoint?.run?.checkpointVersion) ? checkpoint.run.checkpointVersion : remoteVersion + 1;
        }
        const nextDecision = await requestResultDecision(local.remoteRunId, result);
        let decisionApplied = null;
        if (nextDecision?.decision === 'wait_human' && ['WAITING_HUMAN', 'UNKNOWN', 'CHECKPOINT', 'PAUSED'].includes(result.status)) {
          decisionApplied = runtime.applyResultDecision(result.runId, 'wait_human', { reason: 'server_result_decision', checkpoint: result.checkpoint || null });
        } else if (nextDecision?.decision && result.status === 'COMPLETED' && ['continue', 'complete'].includes(nextDecision.decision)) {
          decisionApplied = runtime.applyResultDecision(result.runId, nextDecision.decision, { reason: 'server_result_decision' });
        } else if (nextDecision?.decision) {
          decisionApplied = { action: 'suggested', decision: nextDecision.decision, requiresManualGate: true };
        }
        emitState(); return { ...(decisionApplied?.run || result), nextDecision, decisionApplied };
      } catch (error) {
        if (leaseHeld) await solidifyRemoteWorkflow(local.remoteRunId, error.message);
        throw error;
      } finally {
        if (leaseHeld) {
          try { await api.releaseWorkflowLease(local.remoteRunId, { idempotencyKey: safeIdempotencyKey(`lease:release:${local.remoteRunId}:${local.runId}:${deviceId}`) }); } catch (error) { console.warn('[workflow] lease release failed', local.remoteRunId, error.message); }
        }
      }
    }, { taskId: `resume:${normalizedRunId}`, metadata: { platformAccountId: requestedPlatform } });
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
  ipcMain.handle('browser:open', wrap(async (_event, url) => { if (engine.publicLicense().state !== 'authorized') throw new Error('请先登录并通过授权检查'); const requestEpoch = sessionEpoch; const requestBrowser = browser; const requested = targetUrl(url); engine.pauseAll('browser_navigation'); const finalUrl = await requestBrowser.open(requested); if (requestEpoch !== sessionEpoch || requestBrowser !== browser) throw new Error('授权会话已切换，页面结果已丢弃'); if (finalUrl && finalUrl !== requested) dataStore.update((data) => ({ ...data, tasks: data.tasks.map((task) => task.url === requested ? { ...task, url: finalUrl, updatedAt: new Date().toISOString() } : task) })); return browserState; }));
  ipcMain.handle('browser:search', wrap(async (_event, input) => { if (engine.publicLicense().state !== 'authorized') throw new Error('请先登录并通过授权检查'); const requestEpoch = sessionEpoch; const requestBrowser = browser; const result = await requestBrowser.search({ keyword: text(input?.keyword, 'keyword', 200), maxVideos: Number(input?.maxVideos || 20), scrollRounds: Number(input?.scrollRounds || 2), cursor: input?.cursor || undefined, minRelevance: Number(input?.minRelevance || 0) }); if (requestEpoch !== sessionEpoch || requestBrowser !== browser) throw new Error('授权会话已切换，搜索结果已丢弃'); return result; }));
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
      const accountBrowser = createBrowserInstance(userId, platformAccount);
      const runtime = createWorkflowRuntimeForStore(store, userId, platformAccount, accountBrowser);
      return { accountId, store, runtime, close: () => accountBrowser.close() };
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
