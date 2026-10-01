import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageRoot = resolve(process.env.LINUX_PACKAGE_ROOT || join(root, 'release-local', 'linux-server-4.0.0'));
const databaseRoot = mkdtempSync(join(tmpdir(), 'douyin-v4-linux-package-'));
const dbPath = join(databaseRoot, 'license.sqlite');
const envFile = join(packageRoot, '.env');
const bootstrapUser = `package-admin-${Date.now()}`;
const bootstrapPassword = `package-password-${Date.now()}`;

function ensureRuntimeDependencies() {
  if (existsSync(join(packageRoot, 'node_modules', 'fastify', 'package.json'))) return;
  const npmCommand = process.platform === 'win32' ? process.execPath : join(dirname(process.execPath), 'npm');
  const npmArgs = process.platform === 'win32' ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'ci', '--omit=dev', '--ignore-scripts'] : ['ci', '--omit=dev', '--ignore-scripts'];
  const result = spawnSync(npmCommand, npmArgs, {
    cwd: packageRoot,
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe'
  });
  if (result.status !== 0) throw new Error(`production dependency install failed: ${result.error?.message || result.stderr || result.stdout}`);
}

async function requestJson(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const body = await response.json();
  assert.equal(response.ok, true, `${response.status} ${path}: ${JSON.stringify(body)}`);
  return body;
}

function waitExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => child.once('exit', resolvePromise));
}

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

async function waitHealth(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return await response.json();
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error('packaged Linux server did not become healthy');
}

function stop(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGTERM');
}

async function start(port) {
  const child = spawn(process.execPath, ['--env-file=.env', 'dist/main.js'], {
    cwd: packageRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', DB_PATH: dbPath, HOST: '127.0.0.1', PORT: String(port), OPENAI_COMPATIBLE_BASE_URL: '', OPENAI_COMPATIBLE_API_KEY: '', OPENAI_COMPATIBLE_MODEL: '' }
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });
  try {
    const health = await waitHealth(`http://127.0.0.1:${port}`);
    return { child, health, output };
  } catch (error) {
    stop(child);
    throw new Error(`${error.message}; output=${output.slice(0, 1000)}`);
  }
}

async function main() {
  assert.equal(existsSync(join(packageRoot, 'dist', 'main.js')), true);
  assert.equal(existsSync(join(packageRoot, 'package-lock.json')), true);
  ensureRuntimeDependencies();
  writeFileSync(envFile, [
    'NODE_ENV=production',
    'DB_PATH=./data/license.sqlite',
    'HOST=127.0.0.1',
    'PORT=18080',
    'DRAFT_TIMEOUT_MS=30000',
    'OPENAI_COMPATIBLE_BASE_URL=',
    'OPENAI_COMPATIBLE_API_KEY=',
    'OPENAI_COMPATIBLE_MODEL=',
    ''
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  const port = await freePort();
  const bootstrap = spawnSync(process.execPath, ['--env-file=.env', 'dist/bootstrap.js'], {
    cwd: packageRoot,
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, ADMIN_USERNAME: bootstrapUser, ADMIN_PASSWORD: bootstrapPassword }
  });
  assert.equal(bootstrap.status, 0, `bootstrap failed: ${bootstrap.stderr || bootstrap.stdout}`);
  assert.equal(bootstrap.stdout.includes(bootstrapPassword), false, 'bootstrap output must not echo password');
  const first = await start(port);
  assert.equal(first.health.ok, true);
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminLogin = await requestJson(baseUrl, '/v1/admin/auth/login', { method: 'POST', body: JSON.stringify({ username: bootstrapUser, password: bootstrapPassword }) });
  const adminHeaders = { authorization: `Bearer ${adminLogin.token}` };
  const created = await requestJson(baseUrl, '/v1/admin/users', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ username: `package-shop-${Date.now()}`, expiresAt: Date.now() + 86_400_000 }) });
  assert.ok(created.username && created.password && created.password.length >= 8, 'admin must return generated merchant credentials');
  const merchantLogin = await requestJson(baseUrl, '/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: created.username, password: created.password, deviceId: 'linux-package-verifier', deviceName: 'Linux package verifier' }) });
  const merchantHeaders = { authorization: `Bearer ${merchantLogin.token}` };
  const credit = await requestJson(baseUrl, `/v1/admin/users/${encodeURIComponent(created.id)}/credits`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ amount: 3, idempotencyKey: `linux-package-credit-${Date.now()}` }) });
  assert.equal(credit.balance, 3);
  const me = await requestJson(baseUrl, '/v1/me', { headers: merchantHeaders });
  assert.equal(me.user.username, created.username); assert.equal(me.balance, 3);
  const ledger = await requestJson(baseUrl, `/v1/admin/users/${encodeURIComponent(created.id)}/ledger`, { headers: adminHeaders });
  assert.equal(ledger.balance, 3); assert.ok(ledger.entries.some((entry) => entry.delta === 3), 'credit ledger entry must persist');
  stop(first.child);
  await waitExit(first.child);
  const second = await start(port);
  assert.equal(second.health.ok, true, 'restart must open the same database');
  const restartedAdminLogin = await requestJson(baseUrl, '/v1/admin/auth/login', { method: 'POST', body: JSON.stringify({ username: bootstrapUser, password: bootstrapPassword }) });
  const restartedLedger = await requestJson(baseUrl, `/v1/admin/users/${encodeURIComponent(created.id)}/ledger`, { headers: { authorization: `Bearer ${restartedAdminLogin.token}` } });
  assert.equal(restartedLedger.balance, 3, 'credit ledger must survive restart');
  stop(second.child);
  await waitExit(second.child);
  console.log(JSON.stringify({ pass: true, packageRoot, bootstrapUser, health: second.health, restart: true, generatedUser: true, balance: restartedLedger.balance, ledgerEntries: restartedLedger.entries.length }));
}

try {
  await main();
} finally {
  try { rmSync(envFile, { force: true }); } catch {}
  try { rmSync(databaseRoot, { recursive: true, force: true }); } catch {}
}
