import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const desktopRoot = join(root, 'desktop');
const workDir = mkdtempSync(join(tmpdir(), 'douyin-v4-electron-login-'));
const dbPath = join(workDir, 'license.sqlite');
const userData = join(workDir, 'electron-user-data');
const errorLog = join(workDir, 'electron-errors.jsonl');
const evidenceDir = join(root, 'evidence-private', 'electron-ui');
mkdirSync(evidenceDir, { recursive: true });

const { buildApp } = await import(pathToFileURL(join(root, 'server', 'dist', 'app.js')));
const { Store } = await import(pathToFileURL(join(root, 'server', 'dist', 'store.js')));
const { hashPassword, randomId } = await import(pathToFileURL(join(root, 'server', 'dist', 'security.js')));

async function http(baseUrl, method, route, body, token) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${payload.code || response.status}: ${payload.message || 'request failed'}`);
  return payload;
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message || 'CDP error')) : pending.resolve(message.result || {});
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 10_000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connect failed')); }, { once: true });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'renderer evaluation failed');
    return result.result?.value;
  }
  async screenshot(file) { const result = await this.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(file, Buffer.from(result.data, 'base64')); }
  close() { try { this.ws.close(); } catch {} }
}

async function waitForPage(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Electron page did not start');
}

async function waitFor(cdp, expression, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`wait failed: ${label}`);
}

async function main() {
  const password = `fixture-${randomUUID()}`;
  const adminName = `admin-${randomUUID().slice(0, 8)}`;
  const store = new Store(dbPath);
  store.run('INSERT INTO admins(id,username,password_hash,created_at) VALUES(?,?,?,?)', randomId('admin'), adminName, await hashPassword(password), Date.now());
  store.close();

  const app = await buildApp({ dbPath, host: '127.0.0.1', port: 0, userSessionTtlMs: 600_000, adminSessionTtlMs: 600_000, logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const admin = await http(baseUrl, 'POST', '/v1/admin/auth/login', { username: adminName, password });
  const user = await http(baseUrl, 'POST', '/v1/admin/users', { username: `ui-${randomUUID().slice(0, 8)}`, expiresAt: Date.now() + 3_600_000, maxDevices: 2, features: { evaluate: true, draft: false } }, admin.token);
  const electronPort = 9500 + Math.floor(Math.random() * 200);
  const electronPath = join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electronPath, [join(root, 'scripts', 'electron-test-launcher.cjs'), `--remote-debugging-port=${electronPort}`, `--user-data-dir=${userData}`, '--disable-gpu'], { cwd: root, env: { ...process.env, DOUYIN_LICENSE_API: baseUrl, DOUYIN_AGENT_ERROR_LOG: errorLog }, windowsHide: true, stdio: 'ignore' });
  let cdp;
  try {
    const page = await waitForPage(electronPort);
    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    await waitFor(cdp, `document.querySelector('#license-status')?.textContent === '未授权'`, 'unauthorized state');
    assert.equal(await cdp.evaluate(`document.querySelector('#notice')?.hidden !== false`), true, 'startup must not show IPC error');
    await cdp.screenshot(join(evidenceDir, '10-login-unauthorized.png'));
    const fill = async (selector, value) => cdp.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    assert.equal(await fill('#login-form input[name="username"]', user.username), true);
    assert.equal(await fill('#login-form input[name="password"]', user.password), true);
    assert.equal(await cdp.evaluate('(() => { const form = document.querySelector("#login-form"); form?.requestSubmit(); return Boolean(form); })()'), true);
    await waitFor(cdp, `document.querySelector('#license-status')?.textContent.startsWith('已授权至')`, 'authorized state');
    assert.equal(await cdp.evaluate(`document.body.innerText.includes(${JSON.stringify(user.password)})`), false, 'password must not appear in renderer');
    assert.equal(await cdp.evaluate('document.body.innerText.includes("Bearer ")'), false, 'token must not appear in renderer');
    await cdp.screenshot(join(evidenceDir, '11-login-authorized.png'));
    const errors = existsSync(errorLog) ? readFileSync(errorLog, 'utf8').trim() : '';
    assert.equal(errors.includes('EXDEV'), false, `Electron startup dialog reported EXDEV: ${errors}`);
    console.log(`Electron login PASS; isolated userData=${userData}; evidence=${evidenceDir}`);
  } finally {
    cdp?.close();
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill();
    await app.close();
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

try { await main(); }
catch (error) { console.error(`Electron login FAIL: ${error.stack || error.message}`); process.exitCode = 1; }
