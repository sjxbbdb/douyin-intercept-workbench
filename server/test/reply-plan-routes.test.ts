import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { registerReplyPlanRoutes } from '../src/reply-plan-routes.js';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'reply-plan-')); const store = new Store(join(dir, 'db.sqlite')); const userId = 'user-reply-plan';
  store.run('INSERT INTO admins(id,username,password_hash,created_at) VALUES(?,?,?,?)', 'admin-reply-plan', 'admin-reply-plan', 'hash', Date.now());
  store.run('INSERT INTO users(id,username,password_hash,expires_at,created_at) VALUES(?,?,?,?,?)', userId, 'reply-plan-user', 'hash', Date.now() + 86_400_000, Date.now());
  store.run('INSERT INTO workflow_definitions(workflow_id,version,name,status,contract_json,created_by,created_at) VALUES(?,?,?,?,?,?,?)', 'comment.batch', '1', '评论批次', 'active', '{"steps":["reply"]}', 'admin-reply-plan', Date.now());
  const app = Fastify({ logger: false });
  registerReplyPlanRoutes(app, {
    store,
    userFromRequest: () => ({ user_id: userId }),
    knowledgeRetrieve: async ({ knowledgeSetId, version }) => ({ knowledgeSetId, version: version ?? 3, results: [{ chunkId: 'c1', text: '价格与套餐请以页面说明为准', score: 0.9 }] }),
    providerReplyPlan: async ({ knowledge, targets }) => { assert.equal(knowledge.results[0].text, '价格与套餐请以页面说明为准'); assert.equal(targets.length, 1); return { publicReply: '欢迎咨询', privateReply: '我把套餐详情发给您' }; },
  });
  await app.ready();
  return { app, store, userId, close: async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('reply plan freezes provider output with tenant/version snippets and is idempotent', async () => {
  const f = await fixture(); try {
    const body = { workflowId: 'comment.batch', version: '1', params: { url: 'https://www.douyin.com/video/1', keywords: ['价格'] }, knowledgeSetId: 'set-a', knowledgeSetVersion: 3, query: '价格套餐', targets: [{ eventId: 'e1', text: '多少钱' }], idempotencyKey: 'reply-plan-001' };
    const first = await f.app.inject({ method: 'POST', url: '/v1/reply-plans', payload: body }); assert.equal(first.statusCode, 200, first.body); const result = first.json(); assert.equal(result.status, 'issued'); assert.equal(result.params.publicReply, '欢迎咨询'); assert.equal(result.params.privateReply, '我把套餐详情发给您'); assert.equal(result.params.knowledgeSetVersion, 3);
    const replay = await f.app.inject({ method: 'POST', url: '/v1/reply-plans', payload: body }); assert.deepEqual(replay.json(), result);
    const plan = f.store.get<any>('SELECT * FROM workflow_plans WHERE id=?', result.planId); assert.equal(plan.workflow_version, '1'); assert.equal(JSON.parse(plan.params_json).replyPlan.knowledgeSetId, 'set-a');
    const lookup = await f.app.inject({ method: 'GET', url: '/v1/reply-plans/reply-plan-001' }); assert.deepEqual(lookup.json(), result);
  } finally { await f.close(); }
});

test('missing knowledge waits for a human and provider is not called', async () => {
  const f = await fixture(); try {
    let calls = 0; const body = { workflowId: 'comment.batch', version: '1', params: {}, knowledgeSetId: 'set-empty', query: '未知', idempotencyKey: 'reply-plan-empty' };
    (f as any).app.close; // keep fixture setup shared while replacing only the provider is out of scope
    const app = Fastify({ logger: false }); registerReplyPlanRoutes(app, { store: f.store, userFromRequest: () => ({ user_id: f.userId }), knowledgeRetrieve: async ({ knowledgeSetId }) => ({ knowledgeSetId, version: 1, results: [] }), providerReplyPlan: async () => { calls += 1; return { publicReply: 'x', privateReply: 'y' }; } }); await app.ready();
    const result = await app.inject({ method: 'POST', url: '/v1/reply-plans', payload: body }); assert.equal(result.statusCode, 200); assert.equal(result.json().status, 'WAITING_HUMAN'); assert.equal(calls, 0); await app.close();
  } finally { await f.close(); }
});

test('provider timeout is returned as unknown and same key can be queried without retrying', async () => {
  const f = await fixture(); try {
    const app = Fastify({ logger: false }); let calls = 0; registerReplyPlanRoutes(app, { store: f.store, userFromRequest: () => ({ user_id: f.userId }), knowledgeRetrieve: async ({ knowledgeSetId }) => ({ knowledgeSetId, version: 1, results: [{ text: '证据' }] }), providerReplyPlan: async () => { calls += 1; throw new Error('timeout'); } }); await app.ready();
    const body = { workflowId: 'comment.batch', version: '1', params: {}, knowledgeSetId: 'set-a', query: '证据', idempotencyKey: 'reply-plan-unknown' }; const first = await app.inject({ method: 'POST', url: '/v1/reply-plans', payload: body }); assert.equal(first.json().status, 'UNKNOWN'); const second = await app.inject({ method: 'POST', url: '/v1/reply-plans', payload: body }); assert.deepEqual(second.json(), first.json()); const lookup = await app.inject({ method: 'GET', url: '/v1/reply-plans/reply-plan-unknown' }); assert.deepEqual(lookup.json(), first.json()); assert.equal(calls, 1); await app.close();
  } finally { await f.close(); }
});
