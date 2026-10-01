import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { hashPassword, randomId } from '../src/security.js';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'authority-test-'));
  const dbPath = join(dir, 'db.sqlite');
  const seed = new Store(dbPath);
  seed.run('INSERT INTO admins(id,username,password_hash,created_at) VALUES(?,?,?,?)', randomId('admin'), 'root', await hashPassword('root-password'), Date.now());
  seed.close();
  const app = await buildApp({ dbPath, logger: false });
  await app.ready();
  const adminLogin = await app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload: { username: 'root', password: 'root-password' } });
  const adminToken = adminLogin.json().token;
  const create = async (username: string, features: Record<string, unknown> = {}) => {
    const response = await app.inject({ method: 'POST', url: '/v1/admin/users', headers: { authorization: `Bearer ${adminToken}` }, payload: { username, expiresAt: Date.now() + 86_400_000, features } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const login = async (user: any, deviceId = `${user.username}-device`) => {
    const response = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: user.username, password: user.password, deviceId, deviceName: deviceId } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().token;
  };
  const close = async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); };
  return { app, adminToken, create, login, dbPath, close };
}

async function register(app: any, adminToken: string, workflowId: string, contract: any, version = '1') {
  const response = await app.inject({ method: 'POST', url: '/v1/admin/workflows', headers: { authorization: `Bearer ${adminToken}` }, payload: { workflowId, version, name: workflowId, contract } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

test('canonical workflow prices are server-owned and exact reserve is required', async () => {
  const f = await fixture();
  try {
    await register(f.app, f.adminToken, 'video.search', { steps: ['search'] });
    await register(f.app, f.adminToken, 'comment.batch', { steps: [{ stepId: 'reply', sideEffect: true }] });
    await register(f.app, f.adminToken, 'comment.batch', { steps: [{ stepId: 'reply', sideEffect: true }], creditPrice: 4 }, '2');
    const user = await f.create('price-owner');
    const creditSeed = await f.app.inject({ method: 'POST', url: `/v1/admin/users/${user.id}/credits`, headers: { authorization: `Bearer ${f.adminToken}` }, payload: { amount: 5, idempotencyKey: 'price-owner-seed' } }); assert.equal(creditSeed.statusCode, 200);
    const token = await f.login(user);
    const wrongVideo = await f.app.inject({ method: 'POST', url: '/v1/credits/actions/reserve', headers: { authorization: `Bearer ${token}` }, payload: { actionKey: 'video-price-wrong', owner: 'workflow:video.search', amount: 2, metadata: {} } });
    assert.equal(wrongVideo.statusCode, 409); assert.equal(wrongVideo.json().code, 'ACTION_PRICE_MISMATCH');
    const video = await f.app.inject({ method: 'POST', url: '/v1/credits/actions/reserve', headers: { authorization: `Bearer ${token}` }, payload: { actionKey: 'video-price-exact', owner: 'workflow:video.search', amount: 1, metadata: {} } });
    assert.equal(video.statusCode, 200); assert.equal(video.json().action.amount, 1);
    const wrongComment = await f.app.inject({ method: 'POST', url: '/v1/credits/actions/reserve', headers: { authorization: `Bearer ${token}` }, payload: { actionKey: 'comment-price-wrong', owner: 'workflow:comment.batch', amount: 1, metadata: {} } });
    assert.equal(wrongComment.statusCode, 409); assert.equal(wrongComment.json().code, 'ACTION_PRICE_MISMATCH');
    const overriddenComment = await f.app.inject({ method: 'POST', url: '/v1/credits/actions/reserve', headers: { authorization: `Bearer ${token}` }, payload: { actionKey: 'comment-price-override', owner: 'workflow:comment.batch', amount: 4, metadata: {} } });
    assert.equal(overriddenComment.statusCode, 200); assert.equal(overriddenComment.json().action.amount, 4);
    const noBalance = await f.create('no-balance'); const noBalanceToken = await f.login(noBalance);
    const denied = await f.app.inject({ method: 'POST', url: '/v1/credits/actions/reserve', headers: { authorization: `Bearer ${noBalanceToken}` }, payload: { actionKey: 'video-no-balance', owner: 'workflow:video.search', amount: 1, metadata: {} } });
    assert.equal(denied.statusCode, 409); assert.equal(denied.json().code, 'INSUFFICIENT_CREDITS');
  } finally { await f.close(); }
});

test('sending workflow cannot complete from client-reported sent_confirmed and keeps hold', async () => {
  const f = await fixture();
  try {
    await register(f.app, f.adminToken, 'comment.batch', { steps: [{ stepId: 'reply', sideEffect: true }] });
    const user = await f.create('send-owner'); const creditSeed = await f.app.inject({ method: 'POST', url: `/v1/admin/users/${user.id}/credits`, headers: { authorization: `Bearer ${f.adminToken}` }, payload: { amount: 2, idempotencyKey: 'send-owner-seed' } }); assert.equal(creditSeed.statusCode, 200); const token = await f.login(user);
    const account = await f.app.inject({ method: 'POST', url: '/v1/platform-accounts', headers: { authorization: `Bearer ${token}` }, payload: { platform: 'douyin', accountRef: 'seller-1', displayName: 'seller' } });
    const platformAccountId = account.json().id;
    const params = { url: 'https://www.douyin.com/video/123', keywords: ['购买'], publicReply: '请咨询', privateReply: '已私信', policyRef: { policyId: 'test', policyVersion: 1 } };
    const planId = 'authority-plan-1';
    const seed = new Store(f.dbPath); seed.run('INSERT INTO workflow_plans(id,user_id,workflow_id,workflow_version,params_json,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)', planId, user.id, 'comment.batch', '1', JSON.stringify(params), 'issued', Date.now(), Date.now() + 60_000); seed.close();
    const reserve = await f.app.inject({ method: 'POST', url: '/v1/credits/actions/reserve', headers: { authorization: `Bearer ${token}` }, payload: { actionKey: 'send-hold-1', owner: 'workflow:comment.batch', amount: 2, metadata: {} } });
    assert.equal(reserve.statusCode, 200, reserve.body);
    const run = await f.app.inject({ method: 'POST', url: '/v1/workflow-runs', headers: { authorization: `Bearer ${token}` }, payload: { planId, workflowId: 'comment.batch', version: '1', params, platformAccountId, creditActionId: reserve.json().action.id, idempotencyKey: 'send-run-001' } });
    assert.equal(run.statusCode, 200, run.body); const runId = run.json().run.id;
    const running = await f.app.inject({ method: 'POST', url: `/v1/workflow-runs/${runId}/checkpoints`, headers: { authorization: `Bearer ${token}` }, payload: { status: 'RUNNING', expectedVersion: 0 } }); assert.equal(running.statusCode, 200);
    const spoofed = await f.app.inject({
      method: 'POST',
      url: `/v1/workflow-runs/${runId}/checkpoints`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'COMPLETED', expectedVersion: 1, targetState: { deliveryStatus: 'sent_confirmed', confirmed: true } },
    });
    assert.equal(spoofed.statusCode, 409); assert.equal(spoofed.json().code, 'SEND_EVIDENCE_REQUIRED');
    const action = await f.app.inject({ method: 'GET', url: `/v1/credits/actions/${reserve.json().action.id}`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(action.json().action.status, 'reserved');
  } finally { await f.close(); }
});

test('manual completion mints server proof, settles credit, and is idempotent', async () => {
  const f = await fixture();
  try {
    await register(f.app, f.adminToken, 'comment.batch', { steps: [{ stepId: 'reply', sideEffect: true }] });
    const user = await f.create('manual-owner');
    const creditSeed = await f.app.inject({ method: 'POST', url: `/v1/admin/users/${user.id}/credits`, headers: { authorization: `Bearer ${f.adminToken}` }, payload: { amount: 2, idempotencyKey: 'manual-owner-seed' } }); assert.equal(creditSeed.statusCode, 200);
    const token = await f.login(user);
    const account = await f.app.inject({ method: 'POST', url: '/v1/platform-accounts', headers: { authorization: `Bearer ${token}` }, payload: { platform: 'douyin', accountRef: 'manual-seller', displayName: 'seller' } }); assert.equal(account.statusCode, 200);
    const params = { url: 'https://www.douyin.com/video/456', keywords: ['购买'], publicReply: '请咨询', privateReply: '已私信', policyRef: { policyId: 'test', policyVersion: 1 } };
    const planId = 'manual-plan-1'; const seed = new Store(f.dbPath); seed.run('INSERT INTO workflow_plans(id,user_id,workflow_id,workflow_version,params_json,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)', planId, user.id, 'comment.batch', '1', JSON.stringify(params), 'issued', Date.now(), Date.now() + 60_000); seed.close();
    const reserve = await f.app.inject({ method: 'POST', url: '/v1/credits/actions/reserve', headers: { authorization: `Bearer ${token}` }, payload: { actionKey: 'manual-hold-1', owner: 'workflow:comment.batch', amount: 2, metadata: {} } }); assert.equal(reserve.statusCode, 200);
    const run = await f.app.inject({ method: 'POST', url: '/v1/workflow-runs', headers: { authorization: `Bearer ${token}` }, payload: { planId, workflowId: 'comment.batch', version: '1', params, platformAccountId: account.json().id, creditActionId: reserve.json().action.id, idempotencyKey: 'manual-run-001' } }); assert.equal(run.statusCode, 200, run.body);
    const runId = run.json().run.id; const lease = await f.app.inject({ method: 'POST', url: `/v1/workflow-runs/${runId}/lease/acquire`, headers: { authorization: `Bearer ${token}` }, payload: { idempotencyKey: 'manual-lease-001' } }); assert.equal(lease.statusCode, 200);
    const running = await f.app.inject({ method: 'POST', url: `/v1/workflow-runs/${runId}/checkpoints`, headers: { authorization: `Bearer ${token}` }, payload: { status: 'RUNNING', expectedVersion: 0 } }); assert.equal(running.statusCode, 200);
    const waiting = await f.app.inject({ method: 'POST', url: `/v1/workflow-runs/${runId}/checkpoints`, headers: { authorization: `Bearer ${token}` }, payload: { status: 'WAITING_HUMAN', expectedVersion: 1, humanWait: { reason: '平台回执未验证' } } }); assert.equal(waiting.statusCode, 200);
    const body = { note: '人工检查页面后确认', expectedVersion: 2, idempotencyKey: 'manual-complete-001' };
    const completed = await f.app.inject({ method: 'POST', url: `/v1/workflow-runs/${runId}/manual-complete`, headers: { authorization: `Bearer ${token}` }, payload: body }); assert.equal(completed.statusCode, 200, completed.body); assert.match(completed.json().proofId, /^manual_proof_/); assert.equal(completed.json().run.status, 'COMPLETED');
    const replay = await f.app.inject({ method: 'POST', url: `/v1/workflow-runs/${runId}/manual-complete`, headers: { authorization: `Bearer ${token}` }, payload: body }); assert.deepEqual(replay.json(), completed.json());
    const action = await f.app.inject({ method: 'GET', url: `/v1/credits/actions/${reserve.json().action.id}`, headers: { authorization: `Bearer ${token}` } }); assert.equal(action.json().action.status, 'committed'); assert.equal(action.json().balance, 0);
  } finally { await f.close(); }
});

test('tenant audit is scoped and expired holds emit redacted audit without deleting pending idempotency', async () => {
  const f = await fixture();
  try {
    const user = await f.create('audit-owner', { draft: true }); const token = await f.login(user);
    const seed = new Store(f.dbPath); const now = Date.now(); seed.run("INSERT INTO holds(id,user_id,owner,hold_key,amount,status,expires_at,created_at) VALUES(?,?,?,?,?,'held',?,?)", 'expired-hold', user.id, 'agent.draft', 'draft:audit-pending', 2, now - 1, now - 1000); seed.run("INSERT INTO idempotency(id,user_id,scope,idem_key,payload_hash,status,created_at) VALUES(?,?,?,?,?,?,?)", 'audit-pending-idem', user.id, 'draft', 'audit-pending', 'hash', 'pending', now - 1000); seed.close();
    const trigger = await f.app.inject({ method: 'POST', url: '/v1/agent/draft', headers: { authorization: `Bearer ${token}` }, payload: { event: { id: 'e', source: 'video_comment', roomId: 'r', authorId: 'a', authorName: 'n', text: 'x', observedAt: now }, idempotencyKey: 'audit-trigger-1' } });
    assert.equal(trigger.statusCode, 503); // provider/config gate is after hold recovery
    const audit = await f.app.inject({ method: 'GET', url: '/v1/audit', headers: { authorization: `Bearer ${token}` } });
    assert.equal(audit.statusCode, 200); assert.ok(audit.json().entries.some((entry: any) => entry.action === 'hold.expire'));
    const check = new Store(f.dbPath); const hold = check.get<any>('SELECT status FROM holds WHERE id=?', 'expired-hold'); const pending = check.get<any>("SELECT status FROM idempotency WHERE scope='draft' AND idem_key=?", 'audit-pending'); check.close();
    assert.equal(hold.status, 'released'); assert.equal(pending.status, 'pending');
  } finally { await f.close(); }
});
