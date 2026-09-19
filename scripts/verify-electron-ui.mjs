import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const desktopRoot = join(root, 'desktop');
const launcher = join(root, 'scripts', 'electron-test-launcher.cjs');
const evidenceDir = join(root, 'evidence-private', 'electron-ui');
mkdirSync(evidenceDir, { recursive: true });

const { buildApp } = await import(new URL('../server/dist/app.js', import.meta.url));
const { Store } = await import(new URL('../server/dist/store.js', import.meta.url));
const { hashPassword, randomId } = await import(new URL('../server/dist/security.js', import.meta.url));

const workDir = mkdtempSync(join(tmpdir(), 'douyin-v4-electron-ui-'));
const dbPath = join(workDir, 'license.sqlite');
const userData = join(workDir, 'electron-user-data');
const fixturePassword = `fixture-${randomUUID()}`;
const adminName = `admin-${randomUUID().slice(0, 8)}`;
const failures = [];

async function http(baseUrl, method, path, body, token) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(`${payload.message || `HTTP ${response.status}`} [${payload.code || `HTTP_${response.status}`}]`);
    error.code = payload.code;
    throw error;
  }
  return payload;
}

async function seedAdmin() {
  const store = new Store(dbPath);
  try {
    store.run('INSERT INTO admins(id,username,password_hash,created_at) VALUES(?,?,?,?)', randomId('admin'), adminName, await hashPassword(fixturePassword), Date.now());
  } finally { store.close(); }
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
      const timeout = setTimeout(() => reject(new Error('CDP 连接超时')), 10_000);
      this.socket.addEventListener('open', () => { clearTimeout(timeout); resolvePromise(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP 连接失败')); }, { once: true });
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || '页面脚本执行失败');
    return result.result?.value;
  }
  async close() { try { await this.send('Page.close'); } catch {} try { this.socket.close(); } catch {} }
}

async function waitForPage(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error('Electron 页面未启动');
}

async function waitForTarget(port, predicate, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
      const target = targets.find(predicate);
      if (target) return target;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`等待 Electron 目标窗口超时：${label}`);
}

async function waitFor(cdp, expression, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`等待 UI 状态超时：${label}`);
}

async function click(cdp, selector) {
  const clicked = await cdp.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`);
  assert.equal(clicked, true, `找不到按钮 ${selector}`);
}

async function fill(cdp, selector, value) {
  const filled = await cdp.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; setter?.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  assert.equal(filled, true, `找不到输入框 ${selector}`);
}

async function submit(cdp, selector) {
  const submitted = await cdp.evaluate(`(() => { const form = document.querySelector(${JSON.stringify(selector)}); if (!form) return false; form.requestSubmit(); return true; })()`);
  assert.equal(submitted, true, `找不到表单 ${selector}`);
}

async function screenshot(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(evidenceDir, `${name}.png`), Buffer.from(result.data, 'base64'));
}

function bodyText(cdp) { return cdp.evaluate('document.body.innerText'); }

async function main() {
  await seedAdmin();
  const app = await buildApp({ dbPath, host: '127.0.0.1', port: 0, userSessionTtlMs: 10 * 60_000, adminSessionTtlMs: 10 * 60_000, logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const admin = await http(baseUrl, 'POST', '/v1/admin/auth/login', { username: adminName, password: fixturePassword });
  const users = {};
  for (const label of ['a', 'b']) {
    users[label] = await http(baseUrl, 'POST', '/v1/admin/users', { username: `ui-${label}-${randomUUID().slice(0, 8)}`, expiresAt: Date.now() + 3_600_000, maxDevices: 4, features: { evaluate: true, draft: false } }, admin.token);
    await http(baseUrl, 'POST', `/v1/admin/users/${users[label].id}/credits`, { amount: 3, idempotencyKey: `ui-credit-${label}-${randomUUID()}` }, admin.token);
    await http(baseUrl, 'POST', '/v1/auth/login', { username: users[label].username, password: users[label].password, deviceId: `server-check-${label}`, deviceName: 'integration-check' });
  }

  const electronPort = 9300 + Math.floor(Math.random() * 200);
  const electronPath = join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electronPath, [launcher, `--remote-debugging-port=${electronPort}`, `--user-data-dir=${userData}`, '--disable-gpu'], {
    cwd: root,
    env: { ...process.env, DOUYIN_LICENSE_API: baseUrl },
    windowsHide: true,
    stdio: 'ignore'
  });
  let cdp;
  try {
    const page = await waitForPage(electronPort);
    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.connect();
    await waitFor(cdp, `document.querySelector('#license-status')?.textContent === '未授权'`, '未授权空态');
    assert.equal(await cdp.evaluate(`document.querySelector('#notice')?.hidden !== false`), true, '启动时不得出现 IPC 错误提示');
    await screenshot(cdp, '01-unauthorized');
    assert.equal(await cdp.evaluate('Boolean(document.querySelector("#login-form"))'), true);

    const readonlyUrl = 'https://v.douyin.com/aNdCUl2rQAY/';
    const openedUrl = await cdp.evaluate(`window.agentApi.openTarget(${JSON.stringify(readonlyUrl)})`);
    const douyinTarget = await waitForTarget(electronPort, (target) => target.type === 'page' && target.webSocketDebuggerUrl && target.url.includes('douyin.com') && !target.url.startsWith('file:'), '抖音只读窗口');
    const douyinCdp = new CdpClient(douyinTarget.webSocketDebuggerUrl);
    await douyinCdp.connect();
    await waitFor(douyinCdp, 'document.readyState === "complete"', '抖音页面加载');
    const pageEvidence = await douyinCdp.evaluate(`(() => { const visible = (node) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; }; const candidates = { commentNode: '[data-e2e="comment-item"], [data-e2e="comment-list"] [role="listitem"]', commentText: '[data-e2e="comment-text"]', commentAuthor: '[data-e2e="comment-author"]', commentId: '[data-comment-id]', replyInput: 'textarea, [contenteditable="true"]', sendButton: 'button', replyButton: 'button' }; const counts = Object.fromEntries(Object.entries(candidates).map(([key, selector]) => [key, Array.from(document.querySelectorAll(selector)).filter(visible).length])); const url = new URL(location.href); url.search = ''; url.hash = ''; return { finalUrl: url.href, title: document.title, readyState: document.readyState, bodyTextLength: document.body?.innerText?.length || 0, visibleCandidateCounts: counts }; })()`);
    const canonicalOpenedUrl = new URL(String(pageEvidence.finalUrl)); canonicalOpenedUrl.search = ''; canonicalOpenedUrl.hash = '';
    pageEvidence.openedUrl = canonicalOpenedUrl.href;
    pageEvidence.checkedAt = new Date().toISOString();
    writeFileSync(join(evidenceDir, 'douyin-readonly.json'), `${JSON.stringify(pageEvidence, null, 2)}\n`);
    await screenshot(douyinCdp, '09-douyin-readonly');
    await douyinCdp.close();
    await cdp.evaluate('window.agentApi.closeTarget()');

    await click(cdp, '[data-view="settings"]');
    await waitFor(cdp, 'Boolean(document.querySelector("#endpoint-form"))', '设置页');
    await fill(cdp, '#endpoint-form input[name="endpoint"]', baseUrl);
    await submit(cdp, '#endpoint-form');
    await waitFor(cdp, `document.querySelector('#endpoint-form input[name="endpoint"]')?.value === ${JSON.stringify(baseUrl)}`, '保存 server URL');
    await screenshot(cdp, '02-settings-unauthorized');

    await click(cdp, '[data-view="tasks"]');
    await waitFor(cdp, 'Boolean(document.querySelector("#login-form"))', '未授权登录页');
    await fill(cdp, '#login-form input[name="username"]', 'wrong-user');
    await fill(cdp, '#login-form input[name="password"]', 'wrong-password');
    await submit(cdp, '#login-form');
    await waitFor(cdp, `document.querySelector('#notice')?.dataset.kind === 'error'`, '错误登录提示');
    assert.equal(await cdp.evaluate(`document.querySelector('#notice')?.textContent.includes('登录成功')`), false);
    await fill(cdp, '#login-form input[name="password"]', '');
    await screenshot(cdp, '03-login-error');

    await fill(cdp, '#login-form input[name="username"]', users.a.username);
    await fill(cdp, '#login-form input[name="password"]', users.a.password);
    await submit(cdp, '#login-form');
    try {
      await waitFor(cdp, `document.querySelector('#license-status')?.textContent.startsWith('已授权至')`, 'A 登录');
    } catch (error) {
      console.error(`A 登录 UI 状态：${JSON.stringify(await cdp.evaluate(`({notice: document.querySelector('#notice')?.textContent || '', license: document.querySelector('#license-status')?.textContent || '', endpoint: document.querySelector('#endpoint-form input[name="endpoint"]')?.value || ''})`))}`);
      throw error;
    }
    assert.equal(await cdp.evaluate(`document.body.innerText.includes(${JSON.stringify(users.a.password)})`), false, '页面不得显示密码');
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('Bearer ')`), false, '页面不得显示 token');
    await screenshot(cdp, '04-a-authorized');

    await click(cdp, '[data-view="credits"]');
    await waitFor(cdp, 'Boolean(document.querySelector("#redeem-form"))', '积分页');
    await click(cdp, '[data-action="load-ledger"]');
    await waitFor(cdp, `document.querySelector('#content')?.innerText.includes('admin_credit')`, '服务端积分流水');
    assert.equal(await cdp.evaluate(`document.querySelector('#content')?.innerText.includes('3')`), true);
    await screenshot(cdp, '05-a-ledger');

    await click(cdp, '[data-view="tasks"]');
    await click(cdp, '[data-action="new-task"]');
    await waitFor(cdp, 'Boolean(document.querySelector("#task-form"))', '任务表单');
    await fill(cdp, '#task-form input[name="url"]', 'https://www.douyin.com/video/ui-fixture');
    await fill(cdp, '#task-form input[name="businessContext"]', '账户A临时任务');
    await fill(cdp, '#task-form input[name="targetCustomer"]', '匿名测试客户');
    await fill(cdp, '#task-form input[name="keywords"]', '价格');
    await fill(cdp, '#task-form textarea[name="replyTemplate"]', '您好，{{authorName}}');
    await submit(cdp, '#task-form');
    await waitFor(cdp, `document.querySelector('#content')?.innerText.includes('账户A临时任务')`, 'A 任务保存');
    await screenshot(cdp, '06-a-task');

    await click(cdp, '[data-action="new-task"]');
    await fill(cdp, '#task-form input[name="businessContext"]', '输入中草稿');
    await click(cdp, '#refresh');
    await waitFor(cdp, 'Boolean(document.querySelector("#task-form"))', '刷新后保留任务草稿');
    assert.equal(await cdp.evaluate(`document.querySelector('#task-form input[name="businessContext"]')?.value`), '输入中草稿', '刷新/heartbeat 不得清空任务草稿');
    await click(cdp, '[data-action="cancel-task"]');

    await cdp.evaluate('window.agentApi.logout()');
    await waitFor(cdp, `document.querySelector('#license-status')?.textContent === '未授权'`, 'A 退出');
    await fill(cdp, '#login-form input[name="username"]', users.b.username);
    await fill(cdp, '#login-form input[name="password"]', users.b.password);
    await submit(cdp, '#login-form');
    await waitFor(cdp, `document.querySelector('#license-status')?.textContent.startsWith('已授权至')`, 'B 登录');
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('账户A临时任务')`), false, 'B 不得看到 A 的本地任务');
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('匿名测试客户')`), false, 'B 不得看到 A 的本地线索');
    await screenshot(cdp, '07-b-empty');

    await cdp.evaluate('window.agentApi.logout()');
    await waitFor(cdp, `document.querySelector('#license-status')?.textContent === '未授权'`, 'B 退出');
    await fill(cdp, '#login-form input[name="username"]', users.a.username);
    await fill(cdp, '#login-form input[name="password"]', users.a.password);
    await submit(cdp, '#login-form');
    await waitFor(cdp, `document.querySelector('#content')?.innerText.includes('账户A临时任务')`, 'A 数据恢复');
    await screenshot(cdp, '08-a-restored');
    console.log(`Electron UI PASS; screenshots: ${evidenceDir}`);
  } finally {
    await cdp?.close();
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else if (!child.killed) child.kill();
    await app.close();
    try { rmSync(workDir, { recursive: true, force: true }); } catch (error) { console.warn(`临时 Electron 目录稍后由系统清理：${error.message}`); }
  }
}

try {
  await main();
} catch (error) {
  console.error(`Electron UI FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
}
