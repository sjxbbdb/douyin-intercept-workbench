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
const { targetUrl, text, safeIdempotencyKey } = require('./lib/validation');

let mainWindow;
let authStore;
let api;
let dataStore;
let engine;
let browser;
let browserState = { connected: false, collector: 'closed', matchCount: 0 };
let lastProbe = null;
let apiEndpoint;
let uiFrameUrl;
let sessionEpoch = 0;
let currentAccountUserId = null;
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
  return { tasks: [], events: [], leads: [], logs: [], pending: [], selectorProfile: DEFAULT_SELECTOR_PROFILE };
}

function accountDataPath(userId) {
  const key = crypto.createHash('sha256').update(`${apiEndpoint}:${userId}`).digest('hex').slice(0, 32);
  return path.join(app.getPath('userData'), 'accounts', key, 'agent-data.json');
}

function accountDir(userId) {
  return userId ? path.dirname(accountDataPath(userId)) : path.join(app.getPath('userData'), 'guest-account');
}

function sidecarPort(userId) {
  const digest = crypto.createHash('sha256').update(`${apiEndpoint}:${userId || 'guest'}`).digest();
  return 38000 + ((digest.readUInt16BE(0) % 1200));
}

async function createBrowser(userId) {
  const previous = browser;
  browser = null;
  if (previous) await previous.close?.();
  const callbackEpoch = sessionEpoch;
  const common = {
    onStatus: (status) => { if (callbackEpoch !== sessionEpoch) return; if (status.navigating) engine?.pauseAll('browser_navigation'); if (['captcha', 'login_required', 'unsupported'].includes(status.status)) engine?.pauseAll(`sidecar_${status.status}`); browserState = { ...browserState, ...status }; emitState(); },
    onEvents: (events) => { if (callbackEpoch !== sessionEpoch) return; void engine?.ingest(events); }
  };
  browser = process.env.DOUYIN_ELECTRON_BRIDGE === '1'
    ? new BrowserBridge({ parentWindow: mainWindow, getPartition: () => 'persist:douyin-' + crypto.createHash('sha256').update(apiEndpoint + ':' + (engine?.publicLicense().user?.id || 'guest')).digest('hex').slice(0, 32), ...common })
    : new ProbeBridge({ accountDir: accountDir(userId), port: sidecarPort(userId), cwd: path.resolve(__dirname, '..', '..'), resourcesPath: process.resourcesPath, packaged: app.isPackaged, ...common });
}

function createEngineForStore(nextStore, userId = null) {
  dataStore = nextStore;
  currentAccountUserId = userId;
  engine = new TaskEngine({ store: dataStore, api, authStore, browser, selectorProfile: currentProfile(), onStateChange: emitState, ensureLicense: refreshLicense });
}

function switchAccountStore(userId, reason = 'account_switch', isCurrent = () => true) {
  const ownEpoch = ++sessionEpoch;
  const transition = accountTransition.then(async () => {
    if (ownEpoch !== sessionEpoch || !isCurrent()) return false;
    browserState = { connected: false, collector: 'closed', matchCount: 0 };
    lastProbe = null;
    engine?.invalidate(reason);
    const previous = browser;
    if (previous) await previous.close?.();
    if (ownEpoch !== sessionEpoch || !isCurrent()) return false;
    browser = null;
    authStore?.setLicense(null);
    await createBrowser(userId);
    if (ownEpoch !== sessionEpoch || !isCurrent()) {
      const created = browser;
      browser = null;
      await created?.close?.();
      return false;
    }
    createEngineForStore(new JsonStore(userId ? accountDataPath(userId) : path.join(app.getPath('userData'), 'agent-data-guest.json'), defaultData), userId);
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
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('agent:state', { ...engine.snapshot(), browser: browserState });
}

function currentProfile() { return dataStore.get().selectorProfile || DEFAULT_SELECTOR_PROFILE; }

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
    if (currentAccountUserId !== safe.user.id) {
      const switched = await switchAccountStore(safe.user.id, 'account_switch_from_refresh', () => requestApi === api && authStore.getToken() === requestToken);
      if (!switched) return { state: 'stale' };
    }
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
    const switched = await switchAccountStore(safe.user.id, 'login_account_switch', () => attempt === loginAttempt && requestApi === api);
    if (!switched || attempt !== loginAttempt || requestApi !== api) throw new Error('登录会话已切换，请重试');
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

function registerIpc() {
  const wrap = (handler) => async (event, payload) => { assertLocalSender(event); return handler(event, payload); };
  ipcMain.handle('agent:get-state', wrap(() => ({ ...engine.snapshot(), browser: browserState })));
  ipcMain.handle('agent:login', wrap(handleLogin));
  ipcMain.handle('agent:logout', wrap(handleLogout));
  ipcMain.handle('agent:refresh-license', wrap(() => refreshLicense()));
  ipcMain.handle('agent:get-endpoint', wrap(() => ({ apiEndpoint })));
  ipcMain.handle('agent:set-endpoint', wrap(configureEndpoint));
  ipcMain.handle('task:save', wrap((_event, task) => engine.saveTask(task)));
  ipcMain.handle('task:set-status', wrap((_event, input) => engine.setTaskStatus(text(input?.id, 'task id', 100), input.status)));
  ipcMain.handle('task:delete', wrap((_event, id) => engine.deleteTask(text(id, 'task id', 100))));
  ipcMain.handle('reply:confirm', wrap((_event, actionId) => engine.confirmAction(text(actionId, 'action id', 160))));
  ipcMain.handle('reply:retry-draft', wrap((_event, eventKey) => engine.retryDraft(text(eventKey, 'event key', 240))));
  ipcMain.handle('credits:redeem', wrap(handleRedeem));
  ipcMain.handle('credits:ledger', wrap(async () => { if (!authStore.getToken()) throw new Error('请先登录'); const requestEpoch = sessionEpoch; const requestApi = api; const requestToken = authStore.getToken(); const result = await requestApi.ledger(requestToken); if (requestEpoch !== sessionEpoch || requestApi !== api || authStore.getToken() !== requestToken) throw new Error('授权会话已切换，台账未应用'); return Array.isArray(result) ? result : result.entries || result.ledger || result.items || []; }));
  ipcMain.handle('browser:open', wrap(async (_event, url) => { if (engine.publicLicense().state !== 'authorized') throw new Error('请先登录并通过授权检查'); const requestEpoch = sessionEpoch; const requestBrowser = browser; const requested = targetUrl(url); const finalUrl = await requestBrowser.open(requested); if (requestEpoch !== sessionEpoch || requestBrowser !== browser) throw new Error('授权会话已切换，页面结果已丢弃'); if (finalUrl && finalUrl !== requested) dataStore.update((data) => ({ ...data, tasks: data.tasks.map((task) => task.url === requested ? { ...task, url: finalUrl, updatedAt: new Date().toISOString() } : task) })); return browserState; }));
  ipcMain.handle('browser:search', wrap(async (_event, input) => { if (engine.publicLicense().state !== 'authorized') throw new Error('请先登录并通过授权检查'); const requestEpoch = sessionEpoch; const requestBrowser = browser; const result = await requestBrowser.search(text(input?.keyword, 'keyword', 200), Number(input?.maxVideos || 20), Number(input?.scrollRounds || 2)); if (requestEpoch !== sessionEpoch || requestBrowser !== browser) throw new Error('授权会话已切换，搜索结果已丢弃'); return result; }));
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
  // Read the encrypted token before clearing the cached display license. This
  // keeps startup fail-closed while avoiding a second decryption during the
  // first heartbeat on platforms whose credential backend initializes lazily.
  const startupToken = authStore.getToken();
  // A cached license is only a display hint.  Do not expose it as authorized
  // before the first online /me check; keep the encrypted token for recovery.
  authStore.setLicense(null);
  dataStore = new JsonStore(path.join(userData, 'agent-data-guest.json'), defaultData);
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
  Promise.resolve(browser?.close?.()).catch((error) => console.warn('[desktop] browser close failed', error.message)).finally(() => {
    clearTimeout(deadline);
    app.quit();
  });
});

module.exports = { isAllowedUrl };
