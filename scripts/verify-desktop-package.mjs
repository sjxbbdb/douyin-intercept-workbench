import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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

async function launchAndCheck(label, executable, extraArgs = []) {
  assert.equal(existsSync(executable), true, `${label} artifact missing: ${executable}`);
  const workDir = mkdtempSync(join(tmpdir(), `douyin-v4-package-${label}-`));
  const userData = join(workDir, 'user-data');
  const port = await freePort();
  const child = spawn(executable, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--disable-gpu', ...extraArgs], {
    cwd: root,
    windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path' && key !== 'DOUYIN_PROBE_PYTHON')),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  let cdp;
  try {
    const page = await waitForPage(port);
    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.connect();
    let state;
    const stateDeadline = Date.now() + 20_000;
    while (Date.now() < stateDeadline) {
      state = await cdp.evaluate(`(() => ({
        title: document.title,
        license: document.querySelector('#license-status')?.textContent || '',
        login: Boolean(document.querySelector('#login-form')),
        bodyLength: document.body?.innerText?.length || 0
      }))()`);
      if (state.login) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    assert.equal(state.login, true, `${label} must start in an unauthorised login state: ${JSON.stringify(state)}`);
    assert.equal(stderr.includes('无法启动') || stderr.includes('启动失败'), false, `${label} emitted startup failure: ${stderr}`);
    return { label, userData, state, stderrLength: stderr.length, stderrPreview: stderr.slice(0, 500), resourceProbeExists: existsSync(join(workDir, 'resources', 'probe', 'probe-agent.exe')) };
  } finally {
    cdp?.close();
    killTree(child);
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

async function installAndCheck() {
  assert.equal(existsSync(installer), true, `installer artifact missing: ${installer}`);
  const workDir = mkdtempSync(join(tmpdir(), 'douyin-v4-installer-'));
  const installDir = join(workDir, 'installed');
  const result = spawnSync(installer, ['/S', `/D=${installDir}`], { windowsHide: true, stdio: 'pipe', encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, `installer failed: ${result.stderr || result.stdout || result.error?.message || result.status}`);
  const installedExe = join(installDir, '截流自动回复 Agent.exe');
  assert.equal(existsSync(installedExe), true, `installer did not create ${installedExe}`);
  const installed = await launchAndCheck('installer', installedExe);
  installed.installedResourceProbeExists = existsSync(join(installDir, 'resources', 'probe', 'probe-agent.exe'));
  try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  return installed;
}

async function main() {
  const results = [];
  results.push(await launchAndCheck('portable', portable));
  results.push(await installAndCheck());
  const report = {
    checkedAt: new Date().toISOString(),
    artifacts: [portable, installer].map((path) => ({ path, size: statSync(path).size })),
    results,
    pythonPathRemoved: true,
    sidecarCapability: 'not_run: package resources/probe/probe-agent.exe is absent'
  };
  // The report is deliberately local and ignored; it contains no credentials.
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(results.every((item) => item.resourceProbeExists === true || item.installedResourceProbeExists === true), true, 'package must include probe-agent.exe before release');
  console.log(`Desktop package PASS; report=${reportPath}`);
}

try {
  await main();
} catch (error) {
  console.error(`Desktop package FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
}
