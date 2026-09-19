import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const release = join(root, 'desktop', 'release');
const packageJson = JSON.parse(readFileSync(join(root, 'desktop', 'package.json'), 'utf8'));
const packageVersion = packageJson.version;
const portable = join(release, `截流自动回复 Agent-${packageVersion}-x64-portable.exe`);
const installer = join(release, `截流自动回复 Agent-${packageVersion}-x64-installer.exe`);
const evidenceDir = join(root, 'evidence-private', 'package');
const reportPath = join(evidenceDir, 'latest-package-check.json');

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForPage(port) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      const pages = await response.json();
      const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error('package UI did not expose a DevTools page');
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP error'));
      else pending.resolve(message.result || {});
    });
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('package CDP connection timeout')), 10_000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('package CDP connection failed')); }, { once: true });
    });
    await this.send('Runtime.enable');
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'package UI evaluation failed');
    return result.result?.value;
  }
  close() { try { this.socket.close(); } catch {} }
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGTERM');
}

function hideProcessWindow(pid) {
  if (process.platform !== 'win32' || !pid) return;
  const script = `$type = Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -Name Win32ShowWindow -Namespace PackageVerify -PassThru; $root = ${Number(pid)}; $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add($root); do { $added = $false; foreach ($p in Get-CimInstance Win32_Process | Where-Object { $ids.Contains([int]$_.ParentProcessId) }) { if ($ids.Add([int]$p.ProcessId)) { $added = $true } } } while ($added); $windows = foreach ($id in $ids) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { $before = [bool][User32.User32]::IsWindowVisible($p.MainWindowHandle); [PackageVerify.Win32ShowWindow]::ShowWindow($p.MainWindowHandle, 0) | Out-Null; $after = [bool][User32.User32]::IsWindowVisible($p.MainWindowHandle); [pscustomobject]@{ pid = $id; hidden = (-not $after); wasVisible = $before } } }; $windows | ConvertTo-Json -Compress`;
  const psInit = "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd);' -Name User32 -Namespace User32 -PassThru | Out-Null;";
  const command = `${psInit} ${script}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', command], { encoding: 'utf8', windowsHide: true });
  try {
    const parsed = JSON.parse(String(result.stdout || '[]'));
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch { return []; }
}

function observeChild(child) {
  if (!child) return Promise.resolve({ state: 'missing' });
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ state: 'exited', exitCode: child.exitCode, signalCode: child.signalCode });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (state, extra = {}) => { if (settled) return; settled = true; resolve({ state, ...extra }); };
    child.once('exit', (exitCode, signalCode) => finish('exited', { exitCode, signalCode }));
    child.once('close', (exitCode, signalCode) => finish('closed', { exitCode, signalCode }));
    child.once('error', (error) => finish('error', { message: error.message }));
  });
}

async function waitForObservedChild(observed, timeoutMs = 8_000) {
  const timeout = new Promise((resolvePromise) => setTimeout(() => resolvePromise({ state: 'timeout' }), timeoutMs));
  return Promise.race([observed, timeout]);
}

async function waitForPortClosed(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    } catch {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  return false;
}

async function closePackageWindow({ cdp, child, port, mode }) {
  const observed = observeChild(child);
  if (mode === 'force') {
    killTree(child);
    const processState = await waitForObservedChild(observed);
    const portClosed = await waitForPortClosed(port);
    return { mode, processState, portClosed };
  }
  let windowClose = 'ack';
  try {
    await Promise.race([
      cdp.evaluate('window.close()'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('window.close timeout')), 3_000))
    ]);
  } catch (error) {
    // Closing the renderer can close the CDP socket before Runtime.evaluate
    // returns. The process and port observations below are authoritative.
    windowClose = error.message === 'window.close timeout' ? 'timeout' : 'connection_closed';
  }
  cdp.close();
  const portClosed = await waitForPortClosed(port);
  const processState = await waitForObservedChild(observed);
  if (!portClosed) throw new Error(`normal close timeout: CDP port ${port} remained open`);
  return { mode, windowClose, processState, portClosed };
}

function cleanEnv(extra = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path' && key !== 'DOUYIN_PROBE_PYTHON')), ...extra };
}

async function spawnPackage(executable, userData, port, envOverrides = {}) {
  const child = spawn(executable, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--disable-gpu'], {
    cwd: root,
    windowsHide: true,
    env: cleanEnv(envOverrides),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const page = await waitForPage(port);
  const hiddenWindows = hideProcessWindow(child.pid);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  const lateHiddenWindows = hideProcessWindow(child.pid);
  const windowInfo = [...hiddenWindows, ...lateHiddenWindows].filter((item, index, items) => item?.hidden === true && items.findIndex((candidate) => candidate.pid === item.pid) === index);
  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.connect();
  return { child, cdp, stderr: () => stderr, windowInfo };
}

async function waitFor(cdp, expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  let state = {};
  try { state = await readState(cdp); } catch (error) { state = { readError: error.message }; }
  throw new Error(`package UI timeout: ${label}; state=${JSON.stringify(state)}`);
}

async function fill(cdp, selector, value) {
  const ok = await cdp.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; setter?.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  assert.equal(ok, true, `package UI field missing: ${selector}`);
}

async function setFormValue(cdp, name, value) {
  const ok = await cdp.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(`#task-form [name="${name}"]`)});
    if (!node) return false;
    const next = ${JSON.stringify(String(value))};
    if (node instanceof HTMLSelectElement) node.value = next;
    else {
      const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(node, next);
    }
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return node.value === next;
  })()`);
  assert.equal(ok, true, `package UI task field missing or rejected: ${name}`);
}

async function submit(cdp, selector) {
  const ok = await cdp.evaluate(`(() => { const form = document.querySelector(${JSON.stringify(selector)}); if (!form) return false; form.requestSubmit(); return true; })()`);
  assert.equal(ok, true, `package UI form missing: ${selector}`);
}

async function readState(cdp) {
  return cdp.evaluate(`(() => ({ title: document.title, license: document.querySelector('#license-status')?.textContent || '', login: Boolean(document.querySelector('#login-form')), body: document.body?.innerText || '' }))()`);
}

async function enablePackageDiagnostics(cdp, windowInfo = []) {
  await cdp.evaluate(`(() => {
    window.__packageDiagnostics = { stateEvents: [], actions: [], windowInfo: ${JSON.stringify(windowInfo.filter((item) => item?.hidden === true).map((item) => ({ pid: item.pid, hidden: true })))} };
    window.agentApi.onState((next) => {
      const userId = next?.license?.user?.id;
      window.__packageDiagnostics.stateEvents.push({
        at: Date.now(),
        licenseState: next?.license?.state || null,
        userId: userId == null ? null : String(userId),
        formPresent: Boolean(document.querySelector('#task-form')),
        rendererState: typeof state === 'undefined' ? 'unavailable' : { view: state.view || null, editor: Boolean(state.taskEditor), editorUser: state.taskEditor?.license || null, licenseState: state.data?.license?.state || null },
        activeView: document.querySelector('.nav-item.active')?.dataset?.view || null,
        licenseHeader: document.querySelector('#license-status')?.textContent || ''
      });
    });
    document.addEventListener('click', (event) => {
      const node = event.target.closest?.('[data-action], #refresh, [data-view]');
      if (!node) return;
      window.__packageDiagnostics.actions.push({ at: Date.now(), type: 'click', action: node.dataset.action || node.id || node.dataset.view || null, isTrusted: event.isTrusted });
    }, true);
    document.addEventListener('submit', (event) => {
      window.__packageDiagnostics.actions.push({ at: Date.now(), type: 'submit', action: event.target?.id || null, isTrusted: event.isTrusted });
    }, true);
    return true;
  })()`);
}

async function writePackageDiagnostics(label, cdp, failure) {
  try {
    const diagnostics = await cdp.evaluate(`(() => ({
      failure: ${JSON.stringify(failure)},
      current: {
        formPresent: Boolean(document.querySelector('#task-form')),
        rendererState: typeof state === 'undefined' ? 'unavailable' : { view: state.view || null, editor: Boolean(state.taskEditor), editorUser: state.taskEditor?.license || null, licenseState: state.data?.license?.state || null },
        activeView: document.querySelector('.nav-item.active')?.dataset?.view || null,
        licenseHeader: document.querySelector('#license-status')?.textContent || '',
        bodyHasEditor: Boolean(document.querySelector('.form-panel'))
      },
      diagnostics: window.__packageDiagnostics || null
    }))()`);
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, `package-diagnostics-${label}.json`), `${JSON.stringify(diagnostics, null, 2)}\n`);
  } catch {}
}

function sanitizeDiagnosticText(value) {
  return String(value || '').replace(/(token|password|secret|key|authorization)=?[^\s]+/gi, '$1=[REDACTED]').replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]').slice(0, 1000);
}

async function checkTaskEditorRegression(cdp, label, readStderr = () => '', windowInfo = []) {
  await enablePackageDiagnostics(cdp, windowInfo);
  await cdp.evaluate('document.querySelector("[data-action=\\"new-task\\"]")?.click()');
  await waitFor(cdp, 'Boolean(document.querySelector("#task-form"))', `${label} new task editor`);

  // An empty new form must survive the first focus/blur cycle.
  await cdp.evaluate('(() => { const input = document.querySelector("#task-form [name=url]"); input.focus(); input.blur(); return Boolean(document.querySelector("#task-form")); })()');
  assert.equal(await cdp.evaluate('Boolean(document.querySelector("#task-form"))'), true, `${label} empty editor lost on blur`);

  const values = {
    url: 'https://www.douyin.com/video/package-regression',
    source: 'video',
    contactMode: 'comment',
    decisionMode: 'rule',
    businessContext: '验证用本地测试商品',
    targetCustomer: '验证用测试客户',
    keywords: '价格，套餐',
    excludeKeywords: '投诉，退款',
    replyTemplate: '这是验证用人工回复模板。',
    replyInstructions: '验证用话术要求，不调用生成。',
    mode: 'manual',
    intervalMs: '31000',
    maxActions: '7',
    dailyLimit: '9'
  };
  for (const [name, value] of Object.entries(values)) await setFormValue(cdp, name, value);

  // Exercise the IPC directly three times, then exercise the visible refresh button.
  await cdp.evaluate('window.__packageStateEvents = 0; window.agentApi.onState(() => { window.__packageStateEvents += 1; });');
  await cdp.evaluate('(async () => { for (let i = 0; i < 3; i += 1) await window.agentApi.refreshLicense(); })()');
  await waitFor(cdp, 'window.__packageStateEvents >= 3', `${label} repeated refreshLicense IPC`);
  const beforeButtonRefresh = await cdp.evaluate('window.__packageStateEvents');
  await cdp.evaluate('document.querySelector("#refresh")?.click()');
  await waitFor(cdp, `window.__packageStateEvents >= ${beforeButtonRefresh + 1}`, `${label} refresh button`);
  assert.equal(await cdp.evaluate('Boolean(document.querySelector("#task-form"))'), true, `${label} refresh discarded task editor`);
  assert.equal(await cdp.evaluate('document.querySelector("#task-form [name=businessContext]")?.value'), values.businessContext, `${label} refresh discarded task values`);

  // The production heartbeat is a 30s interval. Keep the editor open through a natural heartbeat.
  const heartbeatStart = Date.now();
  const eventBaseline = await cdp.evaluate('window.__packageStateEvents');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 35_500));
  const heartbeatElapsedMs = Date.now() - heartbeatStart;
  const heartbeatEvents = await cdp.evaluate('window.__packageStateEvents - ' + eventBaseline);
  assert.equal(heartbeatElapsedMs >= 35_000, true, `${label} heartbeat observation was shorter than 35s`);
  assert.equal(heartbeatEvents >= 1, true, `${label} natural heartbeat emitted no state event`);
  const editorAfterHeartbeat = await cdp.evaluate('Boolean(document.querySelector("#task-form"))');
  if (!editorAfterHeartbeat) {
    await writePackageDiagnostics(label, cdp, { phase: 'heartbeat', heartbeatElapsedMs, heartbeatEvents, stderr: sanitizeDiagnosticText(readStderr()) });
  }
  assert.equal(editorAfterHeartbeat, true, `${label} heartbeat discarded task editor`);

  await submit(cdp, '#task-form');
  await waitFor(cdp, 'window.agentApi.getState().then((next) => next.tasks.some((item) => item.businessContext === "验证用本地测试商品"))', `${label} save task state`);
  await waitFor(cdp, '!document.querySelector("#task-form")', `${label} save task list`);
  const saved = await cdp.evaluate('window.agentApi.getState()');
  const task = saved.tasks.find((item) => item.businessContext === '验证用本地测试商品');
  assert.ok(task, `${label} saved task missing`);
  assert.equal(task.mode, 'manual', `${label} test task must remain manual`);
  assert.equal(task.url, values.url, `${label} saved task URL mismatch`);
  assert.equal(task.source, values.source, `${label} saved task source mismatch`);
  assert.equal(task.contactMode, values.contactMode, `${label} saved task contact mode mismatch`);
  assert.equal(task.decisionMode, values.decisionMode, `${label} saved task decision mode mismatch`);
  assert.equal(task.businessContext, values.businessContext, `${label} saved task business context mismatch`);
  assert.equal(task.targetCustomer, values.targetCustomer, `${label} saved task target customer mismatch`);
  assert.deepEqual(task.keywords, ['价格', '套餐'], `${label} saved task keywords mismatch`);
  assert.deepEqual(task.excludeKeywords, ['投诉', '退款'], `${label} saved task exclude keywords mismatch`);
  assert.equal(task.replyTemplate, values.replyTemplate, `${label} saved task reply template mismatch`);
  assert.equal(task.replyInstructions, values.replyInstructions, `${label} saved task reply instructions mismatch`);
  assert.equal(task.intervalMs, Number(values.intervalMs), `${label} saved task interval mismatch`);
  assert.equal(task.maxActions, Number(values.maxActions), `${label} saved task max actions mismatch`);
  assert.equal(task.dailyLimit, Number(values.dailyLimit), `${label} saved task daily limit mismatch`);
  await cdp.evaluate(`window.agentApi.setTaskStatus({ id: ${JSON.stringify(task.id)}, status: 'stopped' })`);
  await waitFor(cdp, `window.agentApi.getState().then((next) => next.tasks.find((item) => item.id === ${JSON.stringify(task.id)})?.status === 'stopped')`, `${label} stop local test task`);
  const stopped = await cdp.evaluate(`window.agentApi.getState().then((next) => next.tasks.find((item) => item.id === ${JSON.stringify(task.id)}))`);
  assert.equal(stopped.status, 'stopped', `${label} test task must remain stopped`);

  await cdp.evaluate(`document.querySelector('[data-action="edit-task"][data-id="${task.id}"]')?.click()`);
  await waitFor(cdp, 'Boolean(document.querySelector("#task-form"))', `${label} edit task`);
  assert.equal(await cdp.evaluate('document.querySelector("#task-form [name=businessContext]")?.value'), values.businessContext, `${label} edit task value mismatch`);
  await cdp.evaluate('document.querySelector("[data-action=cancel-task]")?.click()');
  await waitFor(cdp, '!document.querySelector("#task-form") && document.body.innerText.includes("验证用本地测试商品")', `${label} cancel edit`);
}

function readAuthSnapshot(userData) {
  const authPath = join(userData, 'auth.json');
  if (!existsSync(authPath)) return { exists: false, path: authPath };
  const envelope = JSON.parse(readFileSync(authPath, 'utf8'));
  const value = envelope.value || {};
  const token = value.token;
  return {
    exists: true,
    path: authPath,
    mtime: statSync(authPath).mtime.toISOString(),
    revision: envelope.revision,
    format: envelope.format,
    valueKeys: Object.keys(value).sort(),
    tokenType: token === null ? 'null' : typeof token,
    tokenHasValue: typeof token === 'string' ? token.length > 0 : Boolean(token && Object.keys(token).length),
    endpoint: value.endpoint || null,
    licensePresent: value.license != null
  };
}

async function sidecarCapabilities(executable, cwd) {
  const stateDir = mkdtempSync(join(tmpdir(), 'douyin-v4-package-sidecar-state-'));
  const profileDir = mkdtempSync(join(tmpdir(), 'douyin-v4-package-sidecar-profile-'));
  const port = await freePort();
  const child = spawn(executable, ['--state-dir', stateDir, '--profile-dir', profileDir, '--port', String(port)], {
    cwd,
    windowsHide: true,
    env: cleanEnv(),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = '';
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const result = await new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => { killTree(child); reject(new Error('packaged sidecar capabilities timeout')); }, 15_000);
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk);
      for (const line of buffer.split(/\r?\n/).slice(0, -1)) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch (error) { clearTimeout(timer); killTree(child); reject(new Error(`packaged sidecar emitted non-JSON: ${error.message}`)); return; }
        if (message.ok === true) { clearTimeout(timer); killTree(child); resolveResult(message.result); return; }
        if (message.ok === false) { clearTimeout(timer); killTree(child); reject(new Error(`${message.error?.code || 'SIDECAR_ERROR'}: ${message.error?.message || 'sidecar failed'}`)); return; }
      }
      buffer = buffer.split(/\r?\n/).at(-1) || '';
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdin.write(`${JSON.stringify({ id: 'package-capabilities', method: 'capabilities', params: {} })}\n`);
    child.stdin.end();
  }).finally(() => {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch {}
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
  });
  return { result, stderrLength: stderr.length };
}

async function httpJson(baseUrl, method, path, body, token) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${payload.message || response.status} [${payload.code || 'HTTP_ERROR'}]`);
  return payload;
}

async function setupAuthFixture() {
  const { buildApp } = await import(new URL('../server/dist/app.js', import.meta.url));
  const { Store } = await import(new URL('../server/dist/store.js', import.meta.url));
  const { hashPassword, randomId } = await import(new URL('../server/dist/security.js', import.meta.url));
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'douyin-v4-package-license-'));
  const dbPath = join(fixtureRoot, 'license.sqlite');
  const adminUsername = `package-admin-${randomUUID().slice(0, 8)}`;
  const adminPassword = `Admin-${randomUUID()}-pass`;
  const store = new Store(dbPath);
  try {
    store.run('INSERT INTO admins(id,username,password_hash,created_at) VALUES(?,?,?,?)', randomId('admin'), adminUsername, await hashPassword(adminPassword), Date.now());
  } finally { store.close(); }
  const app = await buildApp({ dbPath, host: '127.0.0.1', port: 0, logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const admin = await httpJson(baseUrl, 'POST', '/v1/admin/auth/login', { username: adminUsername, password: adminPassword });
  const user = await httpJson(baseUrl, 'POST', '/v1/admin/users', { username: `package-user-${randomUUID().slice(0, 8)}`, expiresAt: Date.now() + 3_600_000, maxDevices: 2, features: { evaluate: true, draft: false } }, admin.token);
  await httpJson(baseUrl, 'POST', '/v1/admin/auth/logout', {}, admin.token);
  return { app, baseUrl, username: user.username, password: user.password, cleanup: () => rmSync(fixtureRoot, { recursive: true, force: true }) };
}

async function launchAndCheck(label, executable, auth = null) {
  assert.equal(existsSync(executable), true, `${label} artifact missing: ${executable}`);
  const workDir = mkdtempSync(join(tmpdir(), `douyin-v4-package-${label}-`));
  const userData = join(workDir, 'user-data');
  const port = await freePort();
  let child;
  let cdp;
  let windowInfo = [];
  let stderr = '';
  let readStderr;
  let restartChild;
  let restartCdp;
  let readRestartStderr = () => '';
  const exitMode = process.env.PACKAGE_EXIT_MODE || 'normal';
  let authResult = { tested: false, restarted: false, exitMode };
  try {
    ({ child, cdp, stderr: readStderr, windowInfo } = await spawnPackage(executable, userData, port, auth ? { DOUYIN_LICENSE_API: auth.baseUrl } : {}));
    let state;
    const stateDeadline = Date.now() + 20_000;
    while (Date.now() < stateDeadline) {
      state = await readState(cdp);
      if (state.login) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    assert.equal(state.login, true, `${label} must start in an unauthorised login state: ${JSON.stringify(state)}`);
    stderr = readStderr();
    assert.equal(stderr.includes('无法启动') || stderr.includes('启动失败'), false, `${label} emitted startup failure: ${stderr}`);
    const sidecarProbe = await cdp.evaluate('window.agentApi.probeSelectors({})');
    assert.equal(sidecarProbe?.transport, 'sidecar', `${label} must route selector probe through packaged sidecar`);
    assert.deepEqual(Object.keys(sidecarProbe?.capability || {}).sort(), ['live_capture', 'live_reply', 'private_reply', 'video_capture', 'video_reply'], `${label} sidecar capability keys`);
    if (auth) {
      await fill(cdp, '#login-form input[name="username"]', auth.username);
      await fill(cdp, '#login-form input[name="password"]', auth.password);
      await submit(cdp, '#login-form');
      await waitFor(cdp, `document.querySelector('#license-status')?.textContent.startsWith('已授权至')`, `${label} login`);
      assert.equal((await readState(cdp)).body.includes(auth.password), false, `${label} renderer must not show password`);
      assert.equal((await readState(cdp)).body.includes('Bearer '), false, `${label} renderer must not show token`);
      await cdp.evaluate('window.agentApi.logout()');
      await waitFor(cdp, `document.querySelector('#license-status')?.textContent === '未授权'`, `${label} logout`);
      await fill(cdp, '#login-form input[name="username"]', auth.username);
      await fill(cdp, '#login-form input[name="password"]', auth.password);
      await submit(cdp, '#login-form');
      await waitFor(cdp, `document.querySelector('#license-status')?.textContent.startsWith('已授权至')`, `${label} relogin`);
      await checkTaskEditorRegression(cdp, label, readStderr, windowInfo);
      authResult.beforeStop = readAuthSnapshot(userData);
      authResult.shutdown = await closePackageWindow({ cdp, child, port, mode: exitMode });
      authResult.afterStop = readAuthSnapshot(userData);
      const restartPort = await freePort();
      ({ child: restartChild, cdp: restartCdp, stderr: readRestartStderr } = await spawnPackage(executable, userData, restartPort, { DOUYIN_LICENSE_API: auth.baseUrl }));
      await waitFor(restartCdp, `document.querySelector('#license-status')?.textContent.startsWith('已授权至')`, `${label} restart session`);
      authResult.afterBoot = readAuthSnapshot(userData);
      authResult.tested = true;
      authResult.restarted = true;
    }
    return { label, userData, state, stderrLength: stderr.length, stderrPreview: sanitizeDiagnosticText(stderr), windowInfo: windowInfo.filter((item) => item?.hidden === true).map((item) => ({ pid: item.pid, hidden: true })), sidecarProbe: { transport: sidecarProbe.transport, capabilityKeys: Object.keys(sidecarProbe.capability || {}).sort(), verified: sidecarProbe.verified }, auth: authResult };
  } catch (error) {
    error.message = `${error.message}; auth=${JSON.stringify(authResult)}; currentAuth=${JSON.stringify(readAuthSnapshot(userData))}; packageUserData=${userData}; restartStderr=${readRestartStderr().slice(0, 1000)}`;
    throw error;
  } finally {
    cdp?.close();
    restartCdp?.close();
    killTree(child);
    killTree(restartChild);
    if (process.env.KEEP_PACKAGE_USERDATA !== '1') {
      try { rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  }
}

async function installAndCheck(auth) {
  assert.equal(existsSync(installer), true, `installer artifact missing: ${installer}`);
  const workDir = mkdtempSync(join(tmpdir(), 'douyin-v4-installer-'));
  const installDir = join(workDir, 'installed');
  const result = spawnSync(installer, ['/S', `/D=${installDir}`], { windowsHide: true, stdio: 'pipe', encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, `installer failed: ${result.stderr || result.stdout || result.error?.message || result.status}`);
  const installedExe = join(installDir, '截流自动回复 Agent.exe');
  assert.equal(existsSync(installedExe), true, `installer did not create ${installedExe}`);
  const installed = await launchAndCheck('installer', installedExe, auth);
  const packagedProbe = join(installDir, 'resources', 'probe', 'probe-agent.exe');
  installed.installedResourceProbeExists = existsSync(packagedProbe);
  installed.sidecarCapability = installed.installedResourceProbeExists
    ? await sidecarCapabilities(packagedProbe, join(installDir, 'resources', 'probe'))
    : { status: 'missing', path: 'resources/probe/probe-agent.exe' };
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  return installed;
}

async function main() {
  const auth = await setupAuthFixture();
  const results = [];
  try {
    if (process.env.PACKAGE_DIAG_ONLY === 'portable') {
      const result = await launchAndCheck('portable-diagnostic', portable, auth);
      console.log(JSON.stringify(result));
      return;
    }
    results.push(await launchAndCheck('portable', portable, auth));
    results.push(await installAndCheck(auth));
    const report = {
      checkedAt: new Date().toISOString(),
      artifacts: [portable, installer].map((path) => ({ path, size: statSync(path).size })),
      results,
      pythonPathRemoved: true,
      sidecarCapability: results.find((item) => item.label === 'installer')?.sidecarCapability || { status: 'missing' }
    };
    // The report is deliberately local and ignored; it contains no credentials.
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    assert.equal(results.find((item) => item.label === 'installer')?.installedResourceProbeExists, true, 'package must include probe-agent.exe before release');
    assert.deepEqual(results.map((item) => item.sidecarProbe?.transport), ['sidecar', 'sidecar'], 'both package shapes must use sidecar IPC');
    assert.equal(report.sidecarCapability.result?.protocolVersion, 1, 'packaged sidecar capabilities must respond without Python');
    console.log(`Desktop package PASS; report=${reportPath}`);
  } finally {
    await auth.app.close();
    auth.cleanup();
  }
}

try {
  await main();
} catch (error) {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify({ checkedAt: new Date().toISOString(), pass: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  console.error(`Desktop package FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
}
