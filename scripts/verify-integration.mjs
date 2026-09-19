import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('..', import.meta.url);
const importFromRoot = (relative) => import(new URL(relative, root));

const { buildApp } = await importFromRoot('server/dist/app.js');
const { Store } = await importFromRoot('server/dist/store.js');
const { hashPassword, hashPayload, randomId } = await importFromRoot('server/dist/security.js');
const { ApiClient, ApiError } = await importFromRoot('desktop/src/lib/api-client.js');

const workDir = mkdtempSync(join(tmpdir(), 'douyin-v4-integration-'));
const dbPath = join(workDir, 'license.sqlite');
const fixturePassword = `fixture-${crypto.randomUUID()}`;
const fixtureAdmin = `admin-${crypto.randomUUID().slice(0, 8)}`;
const failures = [];

class MemoryAuthStore {
  constructor(deviceId = `device-${crypto.randomUUID()}`) { this.token = null; this.license = null; this.deviceId = deviceId; }
  getToken() { return this.token; }
  getLicense() { return this.license; }
  setSession(token, license) { this.token = token; this.license = license; }
  setLicense(license) { this.license = license; }
  clear() { this.token = null; this.license = null; }
  getDevice() { return { id: this.deviceId, name: 'integration-fixture' }; }
}

function noSecrets(value) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(fixturePassword), false, '输出不得包含 fixture 密码');
  assert.equal(text.includes('Bearer '), false, '输出不得包含 bearer token');
}

async function http(baseUrl, method, path, body, token) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(`${payload.message || `HTTP ${response.status}`} [${payload.code || `HTTP_${response.status}`}]`);
    error.status = response.status;
    error.code = payload.code || `HTTP_${response.status}`;
    error.body = payload;
    throw error;
  }
  return payload;
}

function event(id, text = '多少钱') {
  return { id, source: 'video_comment', roomId: 'https://www.douyin.com/video/fixture', authorId: 'fixture-author', authorName: 'fixture-user', text, observedAt: Date.now() };
}

function rule() {
  return { keywords: ['多少钱'], excludeKeywords: ['投诉'], replyTemplate: '您好，{{authorName}}，请问您想了解哪个型号？' };
}

function expectApiError(action, code) {
  return action.then(
    () => { throw new Error(`预期错误 ${code}，请求却成功`); },
    (error) => {
      assert.ok(error instanceof ApiError || error.code, '错误必须保留结构化 code');
      assert.equal(error.code, code, `错误码应为 ${code}`);
      return error;
    },
  );
}

function expectApiErrorAny(action, codes) {
  return action.then(
    () => { throw new Error(`预期错误 ${codes.join('/')}，请求却成功`); },
    (error) => {
      assert.ok(error instanceof ApiError || error.code, '错误必须保留结构化 code');
      assert.ok(codes.includes(error.code), `错误码应为 ${codes.join('/')}，实际为 ${error.code}`);
      return error;
    },
  );
}

async function seedAdmin() {
  const { Store: SeedStore } = await importFromRoot('server/dist/store.js');
  const { hashPassword: seedHashPassword, randomId: seedRandomId } = await importFromRoot('server/dist/security.js');
  const store = new SeedStore(dbPath);
  try {
    store.run(
      'INSERT INTO admins(id,username,password_hash,created_at) VALUES(?,?,?,?)',
      seedRandomId('admin'), fixtureAdmin, await seedHashPassword(fixturePassword), Date.now(),
    );
  } finally { store.close(); }
}

function orderedLedger(entries) {
  return [...entries].sort((a, b) => (a.createdAt - b.createdAt) || String(a.id).localeCompare(String(b.id)));
}

function assertLedgerInvariant(ledger) {
  let running = 0;
  for (const row of orderedLedger(ledger.entries)) {
    running += row.delta;
    assert.equal(row.balanceAfter, running, `台账 balanceAfter 不连续: ${row.id}`);
    assert.ok(row.balanceAfter >= 0, `台账余额不得为负: ${row.id}`);
  }
  assert.equal(ledger.balance, running, '台账聚合余额不一致');
}

async function main() {
  await seedAdmin();
  const providerState = { fail: false };
  const providerServer = createServer(async (request, response) => {
    if (providerState.fail) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'fixture provider failure' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ matched: true, intent: 'purchase', confidence: 0.95, reason: 'fixture', reply: '您好，已为您准备回复。' }) } }] }));
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const providerAddress = providerServer.address();
  assert.ok(providerAddress && typeof providerAddress === 'object' && providerAddress.port);
  const app = await buildApp({
    dbPath,
    host: '127.0.0.1',
    port: 0,
    userSessionTtlMs: 60_000,
    adminSessionTtlMs: 60_000,
    draftTimeoutMs: 200,
    provider: { baseUrl: `http://127.0.0.1:${providerAddress.port}`, apiKey: 'fixture-provider-key', model: 'fixture-model' },
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object' && address.port, '服务端必须监听随机回环端口');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const adminLogin = await http(baseUrl, 'POST', '/v1/admin/auth/login', { username: fixtureAdmin, password: fixturePassword });
  const adminToken = adminLogin.token;
  const users = new Map();
  const clients = new Map();

  async function createUser(label, options = {}) {
    const data = await http(baseUrl, 'POST', '/v1/admin/users', {
      username: `${label}-${crypto.randomUUID().slice(0, 8)}`,
      expiresAt: Date.now() + (options.expiresInMs ?? 3_600_000),
      maxDevices: options.maxDevices ?? 4,
      features: { evaluate: options.evaluate !== false, draft: options.draft === true },
    }, adminToken);
    users.set(label, data);
    return data;
  }

  async function addCredits(user, amount, suffix = crypto.randomUUID()) {
    return http(baseUrl, 'POST', `/v1/admin/users/${user.id}/credits`, {
      amount, idempotencyKey: `credit-${suffix}`,
    }, adminToken);
  }

  async function loginDesktop(label, user, deviceSuffix = crypto.randomUUID()) {
    const authStore = new MemoryAuthStore();
    const client = new ApiClient({ baseUrl, authStore });
    const deviceId = `fixture-device-${deviceSuffix}`;
    authStore.deviceId = deviceId;
    const credentials = await client.login({ username: user.username, password: user.password, deviceId, deviceName: 'integration fixture' });
    authStore.setSession(credentials.token, credentials);
    clients.set(label, { client, authStore });
    return { client, authStore, credentials };
  }

  async function check(name, fn) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push({ name, error: error instanceof Error ? error.message : String(error) });
      console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    await check('A admin→desktop login→me→credit/redeem→evaluate→ledger', async () => {
      const user = await createUser('a', { draft: true });
      await addCredits(user, 2, 'a-credit');
      const codes = await http(baseUrl, 'POST', '/v1/admin/redeem-codes', { credits: 8, count: 1, expiresAt: Date.now() + 400 * 24 * 60 * 60 * 1000 }, adminToken);
      const { client } = await loginDesktop('a', user);
      const before = await client.me();
      assert.equal(before.user.username, user.username);
      assert.equal(before.balance, 2);
      const redeemed = await client.redeem({ code: codes.codes[0].code, idempotencyKey: `redeem-${crypto.randomUUID()}` });
      assert.equal(redeemed.credits, 8);
      const result = await client.request('POST', '/v1/agent/evaluate', { event: event('a-1'), rule: rule(), idempotencyKey: `eval-${crypto.randomUUID()}` });
      assert.equal(result.matched, true);
      assert.equal(result.charged, 1);
      const ledger = await client.ledger();
      assertLedgerInvariant(ledger);
      noSecrets({ ledger: ledger.entries.map(({ id, delta, balanceAfter, kind }) => ({ id, delta, balanceAfter, kind })) });
    });

    await check('B idempotency replay and payload conflict', async () => {
      const { client } = clients.get('a');
      const idempotencyKey = `eval-replay-${crypto.randomUUID()}`;
      const payload = { event: event('a-replay'), rule: rule(), idempotencyKey };
      const first = await client.request('POST', '/v1/agent/evaluate', payload);
      const second = await client.request('POST', '/v1/agent/evaluate', payload);
      assert.deepEqual(second, first);
      await expectApiError(client.request('POST', '/v1/agent/evaluate', { ...payload, event: event('a-other') }), 'IDEMPOTENCY_CONFLICT');
    });

    await check('C concurrent balance, active hold accounting and provider failure', async () => {
      const user = await createUser('c', { draft: true });
      await addCredits(user, 1, 'c-credit');
      const { client } = await loginDesktop('c', user);
      const attempts = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => client.request('POST', '/v1/agent/evaluate', { event: event(`c-${index}`), rule: rule(), idempotencyKey: `c-eval-${index}-${crypto.randomUUID()}` })));
      const success = attempts.filter((x) => x.status === 'fulfilled' && x.value.matched).length;
      assert.equal(success, 1, '一积分余额并发命中只能成功生成一次');
      await addCredits(user, 5, 'c-draft-credit');
      const ledgerBeforeDraft = await client.ledger();
      const draftKey = `draft-fail-${crypto.randomUUID()}`;
      providerState.fail = true;
      await expectApiError(client.draft({ event: event('c-draft'), replyInstructions: 'fixture failure', idempotencyKey: draftKey }), 'PROVIDER_FAILED');
      const ledgerAfterDraft = await client.ledger();
      assert.equal(ledgerAfterDraft.balance, ledgerBeforeDraft.balance, 'provider 失败不得扣积分');
      await expectApiError(client.draft({ event: event('c-draft'), replyInstructions: 'fixture failure', idempotencyKey: draftKey }), 'PROVIDER_FAILED');
      const store = new Store(dbPath);
      try {
        const holds = store.all('SELECT status FROM holds WHERE user_id=? AND hold_key=?', user.id, `draft:${draftKey}`);
        assert.equal(holds.length, 1, '同一 draft key 只应留下一个可复用 hold 记录');
        assert.equal(holds[0].status, 'released', 'provider 失败后的 hold 必须释放');
      } finally { store.close(); }
    });

    await check('C expired hold clears pending idempotency', async () => {
      const user = users.get('c');
      const { client } = clients.get('c');
      const key = `draft-expired-${crypto.randomUUID()}`;
      const payload = { event: event('c-expired'), businessContext: '', targetCustomer: '', replyInstructions: 'fixture expired hold', idempotencyKey: key };
      const store = new Store(dbPath);
      try {
        store.run('INSERT INTO idempotency(id,user_id,scope,idem_key,payload_hash,status,created_at) VALUES(?,?,?,?,?,?,?)', randomId('idem'), user.id, 'draft', key, hashPayload(payload), 'pending', Date.now() - 1000);
        store.run("INSERT INTO holds(id,user_id,owner,hold_key,amount,status,expires_at,created_at) VALUES(?,?,?,?,?,'held',?,?)", randomId('hold'), user.id, 'agent.draft', `draft:${key}`, 1, Date.now() - 1000, Date.now() - 2000);
      } finally { store.close(); }
      providerState.fail = true;
      await expectApiError(client.draft(payload), 'PROVIDER_FAILED');
    });

    await check('C evaluate respects an active AI hold', async () => {
      const user = await createUser('hold', { draft: true });
      await addCredits(user, 1, 'hold-credit');
      const { client } = await loginDesktop('hold', user);
      const store = new Store(dbPath);
      try {
        store.run("INSERT INTO holds(id,user_id,owner,hold_key,amount,status,expires_at,created_at) VALUES(?,?,?,?,?,'held',?,?)", randomId('hold'), user.id, 'agent.draft', `draft:active-${crypto.randomUUID()}`, 1, Date.now() + 60_000, Date.now());
      } finally { store.close(); }
      await expectApiError(client.request('POST', '/v1/agent/evaluate', { event: event('hold-evaluate'), rule: rule(), idempotencyKey: `hold-eval-${crypto.randomUUID()}` }), 'INSUFFICIENT_CREDITS');
    });

    await check('E real server generation→ApiClient→TaskEngine pending/unknown gate', async () => {
      providerState.fail = false;
      const user = await createUser('engine', { draft: true });
      await addCredits(user, 5, 'engine-credit');
      const desktop = await loginDesktop('engine', user, 'engine');
      const { JsonStore } = await importFromRoot('desktop/src/lib/json-store.js');
      const { TaskEngine } = await importFromRoot('desktop/src/lib/task-engine.js');
      const browser = { sends: [], starts: 0, start() { this.starts += 1; }, async sendReply(reply, source) { this.sends.push({ reply, source }); return { status: 'unknown', reason: 'fixture-unconfirmed' }; } };
      const localStore = new JsonStore(join(workDir, 'desktop-state.json'), () => ({ tasks: [], events: [], leads: [], logs: [], pending: [] }));
      const engine = new TaskEngine({ store: localStore, api: desktop.client, authStore: desktop.authStore, browser, selectorProfile: { verified: false }, onStateChange: () => {} });
      const license = await desktop.client.me();
      engine.setLicense({ ...license, token: desktop.credentials.token });
      assert.equal(JSON.stringify(engine.snapshot()).includes(desktop.credentials.token), false, 'TaskEngine snapshot 不得泄露 token');
      const task = engine.saveTask({ url: 'https://www.douyin.com/video/fixture', source: 'video', keywords: ['多少钱'], excludeKeywords: [], replyTemplate: '您好，请问您想了解哪个型号？', replyInstructions: 'fixture', decisionMode: 'ai', mode: 'manual', intervalMs: 1, dailyLimit: 10, maxActions: 10, status: 'paused' });
      await engine.setTaskStatus(task.id, 'running');
      await engine.ingest([{ id: 'engine-event-1', source: 'video_comment', roomId: task.url, authorId: 'fixture-author', authorName: 'fixture-user', text: '多少钱', observedAt: Date.now() }]);
      let snapshot = engine.snapshot();
      const current = snapshot.events.find((item) => item.authorName === 'fixture-user' && item.text === '多少钱');
      assert.ok(current, `TaskEngine 应保存服务端生成对应的事件: tasks=${JSON.stringify(snapshot.tasks)} events=${JSON.stringify(snapshot.events)}`);
      assert.equal(current.charged, 2, `charged 必须保留服务端生成服务积分整数: ${JSON.stringify(current)}`);
      assert.equal(current.status, 'awaiting_confirmation', '成功生成应进入待确认队列');
      assert.equal(snapshot.pending.length, 1, '成功生成应只入队一次');
      assert.equal(browser.sends.length, 0, 'manual 模式生成后不能自动触发浏览器发送');
      const actionId = snapshot.pending[0].actionId;
      engine.setLicense(null);
      await assert.rejects(() => engine.confirmAction(actionId), /授权已失效/);
      assert.equal(browser.sends.length, 0, '离线/未授权时不得触发浏览器发送');
      engine.setLicense(license);
      const sendResult = await engine.confirmAction(actionId);
      assert.equal(sendResult.status, 'unknown');
      assert.equal(browser.sends.length, 1, '一次确认只能调用一次浏览器发送');
      await assert.rejects(() => engine.confirmAction(actionId), /待确认回复不存在/);
      assert.equal(browser.sends.length, 1, '重复确认不得再次调用浏览器发送');
      snapshot = engine.snapshot();
      assert.equal(snapshot.events.find((item) => item.authorName === 'fixture-user' && item.text === '多少钱').status, 'sent_unknown');
      assert.equal(task.source, 'video');

      await engine.setTaskStatus(task.id, 'paused');
      const ruleTask = engine.saveTask({ url: task.url, source: 'video', keywords: ['高意向'], excludeKeywords: [], replyTemplate: '规则回复 {{authorName}}', replyInstructions: 'fixture', decisionMode: 'rule', mode: 'manual', intervalMs: 0, dailyLimit: 10, maxActions: 10, status: 'paused' });
      await engine.setTaskStatus(ruleTask.id, 'running');
      await engine.ingest([
        { id: 'rule-no-match', source: 'video_comment', roomId: ruleTask.url, authorName: 'low-intent', text: '随便看看', observedAt: new Date().toISOString() },
        { id: 'rule-match-after-no-match', source: 'video_comment', roomId: ruleTask.url, authorName: 'high-intent', text: '我有高意向，多少钱', observedAt: new Date().toISOString() },
      ]);
      snapshot = engine.snapshot();
      const noMatch = snapshot.events.find((item) => item.authorName === 'low-intent');
      const laterMatch = snapshot.events.find((item) => item.authorName === 'high-intent');
      assert.equal(noMatch?.status, 'skipped', '规则不命中应被记录为 skipped');
      assert.equal(laterMatch?.status, 'awaiting_confirmation', '规则不命中不能阻断后续高意向事件');
      assert.equal(snapshot.pending.length, 1, '后续高意向事件应只入队一次');
    });

    await check('D logout, expiry, disable, device revoke and isolation', async () => {
      const user = await createUser('d', { draft: false });
      await addCredits(user, 2, 'd-credit');
      const first = await loginDesktop('d', user, 'd-primary');
      await first.client.logout();
      await expectApiError(first.client.me(), 'AUTH_INVALID');
      first.authStore.clear();
      const second = await loginDesktop('d-second', user, 'd-second');
      const session = new Store(dbPath);
      try {
        session.run('UPDATE sessions SET expires_at=? WHERE user_id=? AND revoked_at IS NULL', Date.now() - 1, user.id);
      } finally { session.close(); }
      await expectApiError(second.client.me(), 'AUTH_EXPIRED');
      const third = await loginDesktop('d-third', user, 'd-third');
      await http(baseUrl, 'PATCH', `/v1/admin/users/${user.id}`, { status: 'disabled' }, adminToken);
      await expectApiErrorAny(third.client.me(), ['ACCOUNT_DISABLED', 'AUTH_INVALID']);
      await http(baseUrl, 'PATCH', `/v1/admin/users/${user.id}`, { status: 'active', expiresAt: Date.now() + 3_600_000 }, adminToken);
      const fourth = await loginDesktop('d-fourth', user, 'd-fourth');
      const deviceId = fourth.authStore.getDevice().id;
      await expectApiError(http(baseUrl, 'GET', `/v1/admin/users/${user.id}/ledger`, undefined, fourth.authStore.getToken()), 'AUTH_INVALID');
      await http(baseUrl, 'POST', `/v1/admin/users/${user.id}/devices/${encodeURIComponent(deviceId)}/revoke`, {}, adminToken);
      await expectApiErrorAny(fourth.client.me(), ['DEVICE_REVOKED', 'AUTH_INVALID']);
    });
  } finally {
    noSecrets({ failures });
    await app.close();
    await new Promise((resolve) => providerServer.close(resolve));
    rmSync(workDir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`Integration failures: ${failures.length}`);
    process.exitCode = 1;
  } else {
    console.log('Integration contract PASS');
  }
}

await main();
