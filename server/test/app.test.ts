import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { buildApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { hashPassword, randomId } from '../src/security.js';

async function fixture(config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'license-test-')); const dbPath = join(dir, 'db.sqlite');
  const seed = new Store(dbPath); seed.run('INSERT INTO admins(id,username,password_hash,created_at) VALUES(?,?,?,?)', randomId('admin'), 'root', await hashPassword('root-password'), Date.now()); seed.close();
  const app = await buildApp({ dbPath, logger: false, ...config }); await app.ready();
  const adminLogin = await app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload: { username: 'root', password: 'root-password' } });
  assert.equal(adminLogin.statusCode, 200); const adminToken = adminLogin.json().token;
  const create = async (extra: Record<string, unknown> = {}) => { const res = await app.inject({ method: 'POST', url: '/v1/admin/users', headers: { authorization: `Bearer ${adminToken}` }, payload: { expiresAt: Date.now() + 86_400_000, ...extra } }); assert.equal(res.statusCode, 200, res.body); return res.json(); };
  const close = async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); };
  return { app, adminToken, create, close, dbPath };
}

const event = (id: string, text = '多少钱') => ({ id, source: 'video_comment', roomId: 'r1', authorId: 'a1', authorName: '客户', text, observedAt: Date.now() });
const rule = { keywords: ['多少钱'], excludeKeywords: ['售后'], replyTemplate: '您好，{{authorName}}，请问您想了解哪个型号？' };
async function providerServer(mode: 'success' | 'invalid' | 'timeout' | 'delay') {
  const server: Server = createServer((_request, response) => {
    if (mode === 'timeout') return;
    const send = () => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(mode === 'invalid' ? { choices: [{ message: { content: '{"matched":true,"intent":"purchase","confidence":0.9,"reason":"有意向","reply":""}' } }] } : { choices: [{ message: { content: '{"matched":true,"intent":"purchase","confidence":0.9,"reason":"有意向","reply":"请留下联系方式"}' } }] })); };
    if (mode === 'delay') setTimeout(send, 150); else send();
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('provider did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}
async function plannerServer() {
  const server: Server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: '{"workflowId":"video.search","version":"1","params":{"source":"fixture"}}' } }] })); }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('planner did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}
async function runCli(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => { const child = spawn('node', ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: process.cwd(), env: { ...process.env, ...env }, windowsHide: true }); let stdout = ''; let stderr = ''; let finished = false; const done = (code: number | null) => { if (!finished) { finished = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } }; const timer = setTimeout(() => { child.kill(); stderr += 'CLI subprocess timeout'; done(null); }, 5000); child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.on('error', (error) => { stderr += String(error); done(null); }); child.on('close', (code) => done(code)); });
}

test('authentication, generated credentials, feature and balance contract', async () => {
  const f = await fixture(); try {
    const created = await f.create(); assert.match(created.username, /^shop_/); assert.ok(created.password);
    const login = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: created.username, password: created.password, deviceId: 'pc-1', deviceName: '店铺电脑' } }); assert.equal(login.statusCode, 200); const token = login.json().token;
    const me = await f.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } }); assert.equal(me.statusCode, 200); assert.equal(me.json().balance, 0); assert.equal(me.json().features.evaluate, true);
    const bad = await f.app.inject({ method: 'GET', url: '/v1/me' }); assert.equal(bad.statusCode, 401);
  } finally { await f.close(); }
});

test('admin credit, evaluate idempotency, mismatch and nonnegative balance', async () => {
  const f = await fixture(); try {
    const user = await f.create({ username: 'buyer' });
    const credit = await f.app.inject({ method: 'POST', url: `/v1/admin/users/${user.id}/credits`, headers: { authorization: `Bearer ${f.adminToken}` }, payload: { amount: 3, idempotencyKey: 'credit-001' } }); assert.equal(credit.statusCode, 200); assert.equal(credit.json().balance, 3);
    const login = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'buyer', password: user.password, deviceId: 'pc-1', deviceName: 'A' } }); const token = login.json().token;
    const call = (body: unknown) => f.app.inject({ method: 'POST', url: '/v1/agent/evaluate', headers: { authorization: `Bearer ${token}` }, payload: body });
    const miss = await call({ event: event('e0', '你好'), rule, idempotencyKey: 'eval-miss-001' }); assert.equal(miss.statusCode, 200); assert.equal(miss.json().charged, 0);
    const e1 = event('e1'); const first = await call({ event: e1, rule, idempotencyKey: 'eval-001' }); assert.equal(first.statusCode, 200); assert.equal(first.json().charged, 1); assert.equal(first.json().balance, 2);
    const replay = await call({ event: e1, rule, idempotencyKey: 'eval-001' }); assert.deepEqual(replay.json(), first.json());
    const mismatch = await call({ event: event('e2'), rule, idempotencyKey: 'eval-001' }); assert.equal(mismatch.statusCode, 409);
    const second = await call({ event: event('e2'), rule, idempotencyKey: 'eval-002' }); assert.equal(second.statusCode, 200); assert.equal(second.json().balance, 1);
    const third = await call({ event: event('e3'), rule, idempotencyKey: 'eval-003' }); assert.equal(third.statusCode, 200); assert.equal(third.json().balance, 0);
    const over = await call({ event: event('e4'), rule, idempotencyKey: 'eval-004' }); assert.equal(over.statusCode, 409); assert.equal(over.json().code, 'INSUFFICIENT_CREDITS');
  } finally { await f.close(); }
});

test('session revoke, device limit, expiry and persistence', async () => {
  const f = await fixture(); try {
    const user = await f.create({ username: 'limited', maxDevices: 1 });
    const login = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'limited', password: user.password, deviceId: 'pc-1', deviceName: 'A' } }); const token = login.json().token;
    const blocked = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'limited', password: user.password, deviceId: 'pc-2', deviceName: 'B' } }); assert.equal(blocked.statusCode, 403); assert.equal(blocked.json().code, 'DEVICE_LIMIT');
    await f.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${token}` } }); const revoked = await f.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } }); assert.equal(revoked.statusCode, 401);
  } finally { await f.close(); }
});

test('redeem is one-time, scoped and password reset revokes sessions', async () => {
  const f = await fixture(); try {
    const user = await f.create({ username: 'redeemer' }); const other = await f.create({ username: 'other' });
    const codeRes = await f.app.inject({ method: 'POST', url: '/v1/admin/redeem-codes', headers: { authorization: `Bearer ${f.adminToken}` }, payload: { credits: 2, count: 1, expiresAt: Date.now() + 86_400_000 } }); assert.equal(codeRes.statusCode, 200); const code = codeRes.json().codes[0].code;
    const login = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: user.username, password: user.password, deviceId: 'pc', deviceName: 'A' } }); const token = login.json().token;
    const redeemBody = { code, idempotencyKey: 'redeem-key-001' }; const redeemed = await f.app.inject({ method: 'POST', url: '/v1/credits/redeem', headers: { authorization: `Bearer ${token}` }, payload: redeemBody }); assert.equal(redeemed.statusCode, 200); assert.equal(redeemed.json().balance, 2);
    const replay = await f.app.inject({ method: 'POST', url: '/v1/credits/redeem', headers: { authorization: `Bearer ${token}` }, payload: redeemBody }); assert.deepEqual(replay.json(), redeemed.json());
    const otherLogin = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: other.username, password: other.password, deviceId: 'pc', deviceName: 'B' } }); const consumed = await f.app.inject({ method: 'POST', url: '/v1/credits/redeem', headers: { authorization: `Bearer ${otherLogin.json().token}` }, payload: { code, idempotencyKey: 'other-redeem-001' } }); assert.equal(consumed.statusCode, 409);
    const reset = await f.app.inject({ method: 'POST', url: `/v1/admin/users/${user.id}/reset-password`, headers: { authorization: `Bearer ${f.adminToken}` }, payload: {} }); assert.equal(reset.statusCode, 200); const old = await f.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } }); assert.equal(old.statusCode, 401);
  } finally { await f.close(); }
});

test('account expiration is checked on every protected request', async () => {
  const f = await fixture(); try {
    const user = await f.create({ username: 'expiring' }); const login = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: user.username, password: user.password, deviceId: 'pc', deviceName: 'A' } }); const token = login.json().token;
    const changed = await f.app.inject({ method: 'PATCH', url: `/v1/admin/users/${user.id}`, headers: { authorization: `Bearer ${f.adminToken}` }, payload: { expiresAt: Date.now() - 1 } }); assert.equal(changed.statusCode, 200);
    const denied = await f.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } }); assert.equal(denied.statusCode, 401); assert.equal(denied.json().code, 'AUTH_EXPIRED');
  } finally { await f.close(); }
});

test('ledger persists across app restart', async () => {
  const f = await fixture(); try {
    const user = await f.create({ username: 'persistent' }); const add = await f.app.inject({ method: 'POST', url: `/v1/admin/users/${user.id}/credits`, headers: { authorization: `Bearer ${f.adminToken}` }, payload: { amount: 7, idempotencyKey: 'persist-seed-001' } }); assert.equal(add.statusCode, 200);
    await f.app.close(); const reopened = await buildApp({ dbPath: f.dbPath, logger: false }); await reopened.ready();
    const login = await reopened.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: user.username, password: user.password, deviceId: 'pc', deviceName: 'A' } }); const me = await reopened.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${login.json().token}` } }); assert.equal(me.statusCode, 200); assert.equal(me.json().balance, 7); await reopened.close();
  } finally { await f.close(); }
});

test('AI provider absence is explicit and does not reserve or charge', async () => {
  const f = await fixture(); try {
    const user = await f.create({ username: 'ai-user', features: { evaluate: true, draft: true } }); const add = await f.app.inject({ method: 'POST', url: `/v1/admin/users/${user.id}/credits`, headers: { authorization: `Bearer ${f.adminToken}` }, payload: { amount: 4, idempotencyKey: 'ai-seed-001' } }); assert.equal(add.statusCode, 200);
    const login = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: user.username, password: user.password, deviceId: 'pc', deviceName: 'A' } }); const response = await f.app.inject({ method: 'POST', url: '/v1/agent/draft', headers: { authorization: `Bearer ${login.json().token}` }, payload: { event: event('ai-1'), businessContext: '商品咨询', idempotencyKey: 'ai-draft-001' } }); assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'PROVIDER_NOT_CONFIGURED');
    const me = await f.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${login.json().token}` } }); assert.equal(me.json().balance, 4);
  } finally { await f.close(); }
});

test('AI provider success is charged once, invalid output and timeout release hold', async () => {
  const provider = await providerServer('success'); const f = await fixture({ provider: { baseUrl: provider.baseUrl, apiKey: 'test-key', model: 'test-model' }, draftTimeoutMs: 100 }); try {
    const user = await f.create({ username: 'ai-success', features: { evaluate: true, draft: true } }); await f.app.inject({ method: 'POST', url: `/v1/admin/users/${user.id}/credits`, headers: { authorization: `Bearer ${f.adminToken}` }, payload: { amount: 5, idempotencyKey: 'ai-credit-001' } }); const login = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: user.username, password: user.password, deviceId: 'pc', deviceName: 'A' } }); const token = login.json().token;
    const payload = { event: event('draft-success'), businessContext: '商品咨询', idempotencyKey: 'draft-success-001' }; const success = await f.app.inject({ method: 'POST', url: '/v1/agent/draft', headers: { authorization: `Bearer ${token}` }, payload }); assert.equal(success.statusCode, 200); assert.equal(success.json().charged, 2); await new Promise<void>((resolve) => provider.server.close(() => resolve())); const replay = await f.app.inject({ method: 'POST', url: '/v1/agent/draft', headers: { authorization: `Bearer ${token}` }, payload }); assert.deepEqual(replay.json(), success.json());
  } finally { await f.close(); await new Promise<void>((resolve) => provider.server.close(() => resolve())); }

  const invalidProvider = await providerServer('invalid'); const invalidFixture = await fixture({ provider: { baseUrl: invalidProvider.baseUrl, apiKey: 'test-key', model: 'test-model' } }); try {
    const user = await invalidFixture.create({ username: 'ai-invalid', features: { evaluate: true, draft: true } }); await invalidFixture.app.inject({ method: 'POST', url: `/v1/admin/users/${user.id}/credits`, headers: { authorization: `Bearer ${invalidFixture.adminToken}` }, payload: { amount: 5, idempotencyKey: 'invalid-credit-001' } }); const login = await invalidFixture.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: user.username, password: user.password, deviceId: 'pc', deviceName: 'A' } }); const result = await invalidFixture.app.inject({ method: 'POST', url: '/v1/agent/draft', headers: { authorization: `Bearer ${login.json().token}` }, payload: { event: event('draft-invalid'), idempotencyKey: 'draft-invalid-001' } }); assert.equal(result.statusCode, 503); const me = await invalidFixture.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${login.json().token}` } }); assert.equal(me.json().balance, 5);
  } finally { await invalidFixture.close(); await new Promise<void>((resolve) => invalidProvider.server.close(() => resolve())); }

  const timeoutProvider = await providerServer('timeout'); const timeoutFixture = await fixture({ provider: { baseUrl: timeoutProvider.baseUrl, apiKey: 'test-key', model: 'test-model' }, draftTimeoutMs: 30 }); try {
    const user = await timeoutFixture.create({ username: 'ai-timeout', features: { evaluate: true, draft: true } }); await timeoutFixture.app.inject({ method: 'POST', url: `/v1/admin/users/${user.id}/credits`, headers: { authorization: `Bearer ${timeoutFixture.adminToken}` }, payload: { amount: 5, idempotencyKey: 'timeout-credit-001' } }); const login = await timeoutFixture.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: user.username, password: user.password, deviceId: 'pc', deviceName: 'A' } }); const result = await timeoutFixture.app.inject({ method: 'POST', url: '/v1/agent/draft', headers: { authorization: `Bearer ${login.json().token}` }, payload: { event: event('draft-timeout'), idempotencyKey: 'draft-timeout-001' } }); assert.equal(result.statusCode, 503); const me = await timeoutFixture.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${login.json().token}` } }); assert.equal(me.json().balance, 5);
  } finally { await timeoutFixture.close(); await new Promise<void>((resolve) => timeoutProvider.server.close(() => resolve())); }
});

test('admin CLI uses the running API and returns generated credentials', async () => {
  const f = await fixture(); try {
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 }); const env = { LICENSE_SERVER_URL: address, ADMIN_USERNAME: 'root', ADMIN_PASSWORD: 'root-password' };
    const created = await runCli(['user-create', '--username', 'cli-smoke'], env); assert.equal(created.code, 0, created.stderr); const credentials = JSON.parse(created.stdout); assert.equal(credentials.username, 'cli-smoke'); assert.ok(credentials.password);
    const credited = await runCli(['credit-add', '--id', credentials.id, '--amount', '3', '--idempotency-key', 'cli-smoke-credit-001'], env); assert.equal(credited.code, 0, credited.stderr); assert.equal(JSON.parse(credited.stdout).balance, 3);
  } finally { await f.close(); }
});

test('HTTP parser errors retain 4xx status and schema rejects unsafe input', async () => {
  const f = await fixture(); try {
    const invalidJson = await f.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{' }); assert.equal(invalidJson.statusCode, 400); assert.equal(invalidJson.json().code, 'INVALID_JSON');
    const media = await f.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'text/plain' }, payload: '{}' }); assert.equal(media.statusCode, 415); assert.equal(media.json().code, 'UNSUPPORTED_MEDIA_TYPE');
    const large = await f.app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ username: 'x'.repeat(70_000) }) }); assert.equal(large.statusCode, 413); assert.equal(large.json().code, 'BODY_TOO_LARGE');
    const user = await f.create({ username: 'schema-user' }); const login = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: user.username, password: user.password, deviceId: 'pc', deviceName: 'A' } }); const token = login.json().token;
    const emptyKeyword = await f.app.inject({ method: 'POST', url: '/v1/agent/evaluate', headers: { authorization: `Bearer ${token}` }, payload: { event: event('schema-1'), rule: { keywords: [''], excludeKeywords: [], replyTemplate: 'x' }, idempotencyKey: 'schema-key-001' } }); assert.equal(emptyKeyword.statusCode, 400);
    const unknown = await f.app.inject({ method: 'POST', url: '/v1/agent/evaluate', headers: { authorization: `Bearer ${token}` }, payload: { event: { ...event('schema-2'), secret: 'x' }, rule, idempotencyKey: 'schema-key-002' } }); assert.equal(unknown.statusCode, 400);
  } finally { await f.close(); }
  const limited = await fixture({ rateLimitMax: 1 }); try { await limited.app.inject({ method: 'GET', url: '/healthz' }); const throttled = await limited.app.inject({ method: 'GET', url: '/healthz' }); assert.equal(throttled.statusCode, 429); assert.equal(throttled.json().code, 'RATE_LIMITED'); } finally { await limited.close(); }
});

test('revocation during AI wait prevents capture and delivery', async () => {
  const provider = await providerServer('delay'); const f = await fixture({ provider: { baseUrl: provider.baseUrl, apiKey: 'test-key', model: 'test-model' }, draftTimeoutMs: 1000 }); try {
    const user = await f.create({ username: 'revoked-during-ai', features: { evaluate: true, draft: true } }); await f.app.inject({ method: 'POST', url: `/v1/admin/users/${user.id}/credits`, headers: { authorization: `Bearer ${f.adminToken}` }, payload: { amount: 5, idempotencyKey: 'revoke-ai-credit-001' } }); const login = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: user.username, password: user.password, deviceId: 'pc', deviceName: 'A' } }); const token = login.json().token;
    const pending = f.app.inject({ method: 'POST', url: '/v1/agent/draft', headers: { authorization: `Bearer ${token}` }, payload: { event: event('revoked-ai'), idempotencyKey: 'revoke-ai-001' } }); await new Promise((resolve) => setTimeout(resolve, 30)); const disabled = await f.app.inject({ method: 'POST', url: `/v1/admin/users/${user.id}/disable`, headers: { authorization: `Bearer ${f.adminToken}` }, payload: {} }); assert.equal(disabled.statusCode, 200); const result = await pending; assert.equal(result.statusCode, 403); const ledger = await f.app.inject({ method: 'GET', url: `/v1/admin/users/${user.id}/ledger`, headers: { authorization: `Bearer ${f.adminToken}` } }); assert.equal(ledger.json().balance, 5);
  } finally { await f.close(); await new Promise<void>((resolve) => provider.server.close(() => resolve())); }
});

test('concurrent charges serialize and do not cross users', async () => {
  const f = await fixture(); try {
    const a = await f.create({ username: 'a' }); const add = await f.app.inject({ method: 'POST', url: `/v1/admin/users/${a.id}/credits`, headers: { authorization: `Bearer ${f.adminToken}` }, payload: { amount: 1, idempotencyKey: 'seed-a-001' } }); assert.equal(add.statusCode, 200);
    const loginA = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'a', password: a.password, deviceId: 'pc', deviceName: 'A' } }); const token = loginA.json().token;
    const [ra, rb] = await Promise.all(['same-key-001', 'other-key-001'].map((key, index) => f.app.inject({ method: 'POST', url: '/v1/agent/evaluate', headers: { authorization: `Bearer ${token}` }, payload: { event: event(`same-${index}`), rule, idempotencyKey: key } })));
    assert.equal([ra.statusCode, rb.statusCode].filter((code) => code === 200).length, 1); assert.equal([ra.statusCode, rb.statusCode].filter((code) => code === 409).length, 1);
  } finally { await f.close(); }
});

test('workflow registry, tenant knowledge metadata and recoverable run contract', async () => {
  const f = await fixture(); try {
    const first = await f.create({ username: 'workflow-a' }); const second = await f.create({ username: 'workflow-b' });
    const workflow = await f.app.inject({ method: 'POST', url: '/v1/admin/workflows', headers: { authorization: `Bearer ${f.adminToken}` }, payload: {
      workflowId: 'comment.reply.v1', version: 1, name: '评论回复固定流程', contract: { steps: [{ id: 'collect', type: 'bounded_collect' }, { id: 'reply', type: 'fixed_reply' }], endCondition: 'queue_empty' }
    } }); assert.equal(workflow.statusCode, 200, workflow.body);
    const duplicate = await f.app.inject({ method: 'POST', url: '/v1/admin/workflows', headers: { authorization: `Bearer ${f.adminToken}` }, payload: {
      workflowId: 'comment.reply.v1', version: 1, name: '重复版本', contract: { steps: [{ id: 'collect' }] }
    } }); assert.equal(duplicate.statusCode, 409);
    const login = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: first.username, password: first.password, deviceId: 'pc-a', deviceName: 'A' } }); const token = login.json().token;
    const otherLogin = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: second.username, password: second.password, deviceId: 'pc-b', deviceName: 'B' } }); const otherToken = otherLogin.json().token;
    const unknownVersion = await f.app.inject({ method: 'POST', url: '/v1/workflow-runs', headers: { authorization: `Bearer ${token}` }, payload: { planId: 'plan-unknown', workflowId: 'comment.reply.v1', version: 2, params: {}, idempotencyKey: 'workflow-run-unknown-001' } }); assert.equal(unknownVersion.statusCode, 404); assert.equal(unknownVersion.json().code, 'WORKFLOW_NOT_FOUND');
    const knowledge = await f.app.inject({ method: 'POST', url: '/v1/knowledge-sets', headers: { authorization: `Bearer ${token}` }, payload: { name: '商品资料', description: '脱敏元数据', metadata: { locale: 'zh-CN', source: 'fixture' } } }); assert.equal(knowledge.statusCode, 200, knowledge.body); assert.equal(knowledge.json().version, 1);
    const knowledgeId = knowledge.json().id;
    const hidden = await f.app.inject({ method: 'PATCH', url: `/v1/knowledge-sets/${knowledgeId}`, headers: { authorization: `Bearer ${otherToken}` }, payload: { description: '越权' } }); assert.equal(hidden.statusCode, 404);
    (f.app as any).store.run('INSERT INTO workflow_plans(id,user_id,workflow_id,workflow_version,params_json,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)', 'plan-fixture-1', first.id, 'comment.reply.v1', '1', JSON.stringify({ batch: 'fixture-1' }), 'issued', Date.now(), Date.now() + 60_000);
    const run = await f.app.inject({ method: 'POST', url: '/v1/workflow-runs', headers: { authorization: `Bearer ${token}` }, payload: { planId: 'plan-fixture-1', workflowId: 'comment.reply.v1', version: 1, params: { batch: 'fixture-1' }, knowledgeSetId: knowledgeId, idempotencyKey: 'workflow-run-001' } }); assert.equal(run.statusCode, 200, run.body); assert.equal(run.json().run.status, 'PLANNED'); assert.equal(run.json().run.planId, 'plan-fixture-1'); assert.equal(run.json().run.knowledgeSet.version, 1);
    const runId = run.json().run.id;
    const replay = await f.app.inject({ method: 'POST', url: '/v1/workflow-runs', headers: { authorization: `Bearer ${token}` }, payload: { planId: 'plan-fixture-1', workflowId: 'comment.reply.v1', version: 1, params: { batch: 'fixture-1' }, knowledgeSetId: knowledgeId, idempotencyKey: 'workflow-run-001' } }); assert.deepEqual(replay.json(), run.json());
    const checkpoint = await f.app.inject({ method: 'POST', url: `/v1/workflow-runs/${runId}/checkpoints`, headers: { authorization: `Bearer ${token}` }, payload: { status: 'RUNNING', stepId: 'collect', cursor: { page: 1 }, targetState: { queue: 'open' }, expectedVersion: 0 } }); assert.equal(checkpoint.statusCode, 200, checkpoint.body); assert.equal(checkpoint.json().run.checkpointVersion, 1);
    const human = await f.app.inject({ method: 'POST', url: `/v1/workflow-runs/${runId}/human-wait`, headers: { authorization: `Bearer ${token}` }, payload: { reason: '需要人工确认登录状态', context: { redacted: true }, expectedVersion: 1 } }); assert.equal(human.statusCode, 200, human.body); assert.equal(human.json().run.status, 'WAITING_HUMAN');
    const premature = await f.app.inject({ method: 'POST', url: `/v1/workflow-runs/${runId}/recover`, headers: { authorization: `Bearer ${token}` }, payload: { checksPassed: 1 } }); assert.equal(premature.statusCode, 409); assert.equal(premature.json().code, 'RECOVERY_CHECKS_REQUIRED');
    const recovered = await f.app.inject({ method: 'POST', url: `/v1/workflow-runs/${runId}/human-wait/resolve`, headers: { authorization: `Bearer ${token}` }, payload: { checksPassed: 2, reason: '人工确认后恢复' } }); assert.equal(recovered.statusCode, 200, recovered.body); assert.equal(recovered.json().run.status, 'RUNNING'); assert.equal(recovered.json().run.recoveryAttempts, 1);
    const stale = await f.app.inject({ method: 'POST', url: `/v1/workflow-runs/${runId}/checkpoints`, headers: { authorization: `Bearer ${token}` }, payload: { status: 'CHECKPOINT', expectedVersion: 1 } }); assert.equal(stale.statusCode, 409); assert.equal(stale.json().code, 'CHECKPOINT_CONFLICT');
    const final = await f.app.inject({ method: 'GET', url: `/v1/workflow-runs/${runId}`, headers: { authorization: `Bearer ${token}` } }); assert.equal(final.statusCode, 200); assert.equal(final.json().checkpoints.length, 3); assert.equal(final.json().run.params.batch, 'fixture-1');
  } finally { await f.close(); }
});

test('agent planner only returns registered fixed workflow and is idempotent', async () => {
  const provider = await plannerServer(); const f = await fixture({ provider: { baseUrl: provider.baseUrl, apiKey: 'test-key', model: 'test-model' } }); try {
    const workflow = await f.app.inject({ method: 'POST', url: '/v1/admin/workflows', headers: { authorization: `Bearer ${f.adminToken}` }, payload: { workflowId: 'video.search', version: '1', name: '查找视频', contract: { steps: ['search'] } } }); assert.equal(workflow.statusCode, 200, workflow.body);
    const user = await f.create({ username: 'planner-user' }); const login = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: user.username, password: user.password, deviceId: 'pc', deviceName: 'A' } }); const token = login.json().token;
    const payload = { intent: '找一批演示视频', context: { redacted: true }, idempotencyKey: 'planner-001' };
    const first = await f.app.inject({ method: 'POST', url: '/v1/agent/plan', headers: { authorization: `Bearer ${token}` }, payload }); assert.equal(first.statusCode, 200, first.body); assert.equal(first.json().workflowId, 'video.search'); assert.equal(first.json().version, '1');
    const replay = await f.app.inject({ method: 'POST', url: '/v1/agent/plan', headers: { authorization: `Bearer ${token}` }, payload }); assert.deepEqual(replay.json(), first.json());
    const disabled = await f.create({ username: 'planner-disabled', features: { workflow: false } }); const disabledLogin = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: disabled.username, password: disabled.password, deviceId: 'pc', deviceName: 'A' } }); const denied = await f.app.inject({ method: 'POST', url: '/v1/agent/plan', headers: { authorization: `Bearer ${disabledLogin.json().token}` }, payload: { ...payload, idempotencyKey: 'planner-disabled-001' } }); assert.equal(denied.statusCode, 403); assert.equal(denied.json().code, 'FEATURE_DISABLED');
  } finally { await f.close(); await new Promise<void>((resolve) => provider.server.close(() => resolve())); }
});

test('credit action reserve commit release is idempotent and bounded', async () => {
  const f = await fixture(); try {
    const user = await f.create({ username: 'credit-actions' });
    await f.app.inject({ method: 'POST', url: `/v1/admin/users/${user.id}/credits`, headers: { authorization: `Bearer ${f.adminToken}` }, payload: { amount: 3, idempotencyKey: 'credit-actions-seed' } });
    const login = await f.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: user.username, password: user.password, deviceId: 'pc', deviceName: 'A' } }); const token = login.json().token;
    const reserve = await f.app.inject({ method: 'POST', url: '/v1/credits/actions/reserve', headers: { authorization: `Bearer ${token}` }, payload: { actionKey: 'reply-action-001', owner: 'reply', amount: 2, metadata: { eventId: 'e1' } } }); assert.equal(reserve.statusCode, 200); assert.equal(reserve.json().action.status, 'reserved');
    const replay = await f.app.inject({ method: 'POST', url: '/v1/credits/actions/reserve', headers: { authorization: `Bearer ${token}` }, payload: { actionKey: 'reply-action-001', owner: 'reply', amount: 2, metadata: { eventId: 'e1' } } }); assert.deepEqual(replay.json(), reserve.json());
    const blocked = await f.app.inject({ method: 'POST', url: '/v1/credits/actions/reserve', headers: { authorization: `Bearer ${token}` }, payload: { actionKey: 'reply-action-002', owner: 'reply', amount: 2, metadata: {} } }); assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().code, 'INSUFFICIENT_CREDITS');
    const actionId = reserve.json().action.id; const commit = await f.app.inject({ method: 'POST', url: `/v1/credits/actions/${actionId}/commit`, headers: { authorization: `Bearer ${token}` }, payload: {} }); assert.equal(commit.statusCode, 200); assert.equal(commit.json().action.status, 'committed'); assert.equal(commit.json().balance, 1);
    const commitReplay = await f.app.inject({ method: 'POST', url: `/v1/credits/actions/${actionId}/commit`, headers: { authorization: `Bearer ${token}` }, payload: {} }); assert.deepEqual(commitReplay.json(), commit.json());
    const second = await f.app.inject({ method: 'POST', url: '/v1/credits/actions/reserve', headers: { authorization: `Bearer ${token}` }, payload: { actionKey: 'reply-action-003', owner: 'reply', amount: 1, metadata: {} } }); assert.equal(second.statusCode, 200); const released = await f.app.inject({ method: 'POST', url: `/v1/credits/actions/${second.json().action.id}/release`, headers: { authorization: `Bearer ${token}` }, payload: {} }); assert.equal(released.json().action.status, 'released');
  } finally { await f.close(); }
});
