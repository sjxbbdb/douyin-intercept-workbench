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
const portable = join(release, '截流自动回复 Agent-4.0.0-x64-portable.exe');
const installer = join(release, '截流自动回复 Agent-4.0.0-x64-installer.exe');
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
  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.connect();
  return { child, cdp, stderr: () => stderr };
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

async function submit(cdp, selector) {
  const ok = await cdp.evaluate(`(() => { const form = document.querySelector(${JSON.stringify(selector)}); if (!form) return false; form.requestSubmit(); return true; })()`);
  assert.equal(ok, true, `package UI form missing: ${selector}`);
}

async function readState(cdp) {
  return cdp.evaluate(`(() => ({ title: document.title, license: document.querySelector('#license-status')?.textContent || '', login: Boolean(document.querySelector('#login-form')), body: document.body?.innerText || '' }))()`);
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
  let stderr = '';
  let readStderr;
  let restartChild;
  let restartCdp;
  let readRestartStderr = () => '';
  try {
    ({ child, cdp, stderr: readStderr } = await spawnPackage(executable, userData, port, auth ? { DOUYIN_LICENSE_API: auth.baseUrl } : {}));
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
    let authResult = { tested: false, restarted: false };
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
      authResult.beforeRestart = readAuthSnapshot(userData);
      cdp.close();
      killTree(child);
      await new Promise((resolvePromise) => child.once('exit', resolvePromise));
      const restartPort = await freePort();
      ({ child: restartChild, cdp: restartCdp, stderr: readRestartStderr } = await spawnPackage(executable, userData, restartPort, { DOUYIN_LICENSE_API: auth.baseUrl }));
      await waitFor(restartCdp, `document.querySelector('#license-status')?.textContent.startsWith('已授权至')`, `${label} restart session`);
      authResult = { tested: true, restarted: true };
    }
    return { label, userData, state, stderrLength: stderr.length, stderrPreview: stderr.slice(0, 500), auth: authResult, resourceProbeExists: existsSync(join(workDir, 'resources', 'probe', 'probe-agent.exe')) };
  } catch (error) {
    error.message = `${error.message}; authBeforeRestart=${JSON.stringify(readAuthSnapshot(userData))}; packageUserData=${userData}; restartStderr=${readRestartStderr().slice(0, 1000)}`;
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
