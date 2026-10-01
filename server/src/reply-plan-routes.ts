import type { FastifyInstance } from 'fastify';
import { AppError, badRequest, conflict } from './errors.js';
import { hashPayload, randomId } from './security.js';
import { Store } from './store.js';
import { validateWorkflowParams } from './workflow-routes.js';

type RecordValue = Record<string, any>;
type RequestValue = { body?: unknown; params?: unknown };
type AuthFn = (request: RecordValue) => RecordValue;

export interface ReplyKnowledgeResult {
  knowledgeSetId: string;
  version: number;
  backend?: string;
  results: Array<{ chunkId?: string; documentId?: string; title?: string; text: string; score?: number; metadata?: RecordValue }>;
}

export interface ReplyPlanProviderInput {
  workflowId: string;
  version: string;
  params: RecordValue;
  idempotencyKey: string;
  knowledge: ReplyKnowledgeResult;
  targets: unknown[];
}

export interface ReplyPlanProviderOutput {
  publicReply: string;
  privateReply: string;
}

interface ReplyPlanRouteDeps {
  store: Store;
  userFromRequest: AuthFn;
  knowledgeRetrieve: (input: { userId: string; knowledgeSetId: string; version?: number; query: string; topK?: number }) => Promise<ReplyKnowledgeResult>;
  providerReplyPlan: (input: ReplyPlanProviderInput) => Promise<ReplyPlanProviderOutput>;
  /** Optional server-side entitlement check. It runs before retrieval/provider use. */
  authorizeWorkflow?: (actor: RecordValue, workflowId: string, version: string) => void;
}

const json = (value: unknown) => JSON.stringify(value);
const parseJson = <T>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const objectValue = (value: unknown, name: string, maxBytes: number): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(json(value), 'utf8') > maxBytes) throw badRequest(`${name} 无效或过大`);
  return value as RecordValue;
};
const stringValue = (value: unknown, name: string, max: number, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw badRequest(`${name} 无效`);
  return value;
};
const keyValue = (value: unknown) => {
  const key = stringValue(value, 'idempotencyKey', 200, true) as string;
  if (key.length < 8) throw badRequest('idempotencyKey 必须是 8-200 个字符');
  return key;
};
const workflowId = (value: unknown) => {
  const id = stringValue(value, 'workflowId', 100, true) as string;
  if (!/^[a-z][a-z0-9._-]{1,99}$/.test(id)) throw badRequest('workflowId 格式无效');
  return id;
};
const workflowVersion = (value: unknown) => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  const version = stringValue(value, 'version', 40, true) as string;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(version)) throw badRequest('version 格式无效');
  return version;
};
const targetList = (value: unknown): unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw badRequest('targets 无效');
  value.forEach((item, index) => objectValue(item, `targets[${index}]`, 4_000));
  return value;
};

function strictReply(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length > 2_000 || !value.trim()) throw new AppError(503, 'REPLY_PLAN_INVALID', `${name} 无效`);
  return value.trim();
}

function providerUnknown(error: unknown) {
  if (error instanceof AppError) return ['PROVIDER_FAILED', 'EMBEDDING_PROVIDER_FAILED', 'EMBEDDING_TIMEOUT', 'PROVIDER_TIMEOUT', 'REPLY_PLAN_TIMEOUT'].includes(error.code);
  return error instanceof Error;
}

function audit(store: Store, userId: string, action: string, metadata: unknown) {
  store.run('INSERT INTO audit(id,actor_type,actor_id,action,target_user_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', randomId('audit'), 'user', userId, action, userId, json(metadata), store.now());
}

function responseFor(row: RecordValue) { return parseJson<RecordValue>(row.response_json, { status: 'UNKNOWN', idempotencyKey: row.idem_key }); }

/**
 * Generates and freezes both reply channels before a fixed workflow is created.
 * It never runs during a workflow checkpoint or execution request.
 */
export function registerReplyPlanRoutes(app: FastifyInstance, deps: ReplyPlanRouteDeps) {
  const { store } = deps;
  const user = (request: RequestValue) => deps.userFromRequest(request as RecordValue);

  app.get('/v1/reply-plans/:idempotencyKey', async (request) => {
    const actor = user(request); const key = keyValue((request.params as RecordValue).idempotencyKey);
    const row = store.get<RecordValue>('SELECT response_json,status,idem_key FROM idempotency WHERE user_id=? AND scope=? AND idem_key=?', actor.user_id, 'reply.plan', key);
    if (!row) throw new AppError(404, 'REPLY_PLAN_NOT_FOUND', '话术计划不存在');
    return responseFor(row);
  });

  app.post('/v1/reply-plans', async (request) => {
    const actor = user(request); const body = objectValue(request.body, '请求体', 64_000);
    const allowed = ['workflowId', 'version', 'params', 'knowledgeSetId', 'knowledgeSetVersion', 'query', 'topK', 'targets', 'idempotencyKey'];
    const unknown = Object.keys(body).filter((key) => !allowed.includes(key)); if (unknown.length) throw badRequest('存在未支持的字段', { fields: unknown });
    const id = workflowId(body.workflowId); const version = workflowVersion(body.version); deps.authorizeWorkflow?.(actor, id, version); const params = objectValue(body.params, 'params', 24_000); validateWorkflowParams(id, params, { requireReplyText: false }); const setId = stringValue(body.knowledgeSetId, 'knowledgeSetId', 100, true) as string; const query = stringValue(body.query, 'query', 4_000, true) as string; const key = keyValue(body.idempotencyKey); const targets = targetList(body.targets);
    const setVersion = body.knowledgeSetVersion === undefined ? undefined : (() => { if (!Number.isSafeInteger(body.knowledgeSetVersion) || body.knowledgeSetVersion < 1) throw badRequest('knowledgeSetVersion 无效'); return body.knowledgeSetVersion as number; })();
    const topK = body.topK === undefined ? 5 : (() => { if (!Number.isSafeInteger(body.topK) || body.topK < 1 || body.topK > 20) throw badRequest('topK 无效'); return body.topK as number; })();
    const payload = { workflowId: id, version, params, knowledgeSetId: setId, knowledgeSetVersion: setVersion ?? null, query, topK, targets, idempotencyKey: key };
    const old = store.get<RecordValue>('SELECT response_json,status,payload_hash,idem_key FROM idempotency WHERE user_id=? AND scope=? AND idem_key=?', actor.user_id, 'reply.plan', key);
    if (old) { if (old.payload_hash !== hashPayload(payload)) throw conflict('IDEMPOTENCY_CONFLICT', '相同幂等键不能用于不同请求'); return responseFor(old); }
    const definition = store.get<RecordValue>("SELECT workflow_id,version,contract_json FROM workflow_definitions WHERE workflow_id=? AND version=? AND status='active'", id, version);
    if (!definition) throw new AppError(404, 'WORKFLOW_NOT_FOUND', '流程版本不存在或未启用');
    store.run('INSERT INTO idempotency(id,user_id,scope,idem_key,payload_hash,status,created_at) VALUES(?,?,?,?,?,?,?)', randomId('idem'), actor.user_id, 'reply.plan', key, hashPayload(payload), 'pending', store.now());
    try {
      const knowledge = await deps.knowledgeRetrieve({ userId: actor.user_id, knowledgeSetId: setId, version: setVersion, query, topK });
      if (!knowledge || knowledge.knowledgeSetId !== setId || !Number.isSafeInteger(knowledge.version) || !Array.isArray(knowledge.results)) throw new AppError(503, 'KNOWLEDGE_RESULT_INVALID', '知识检索结果无效');
      const snippets = knowledge.results.filter((item) => item && typeof item.text === 'string' && item.text.trim()).slice(0, topK);
      if (!snippets.length) {
        const waiting = { status: 'WAITING_HUMAN', reason: 'KNOWLEDGE_NOT_FOUND', knowledgeSet: { id: knowledge.knowledgeSetId, version: knowledge.version }, idempotencyKey: key };
        store.run('UPDATE idempotency SET status=\'completed\',response_json=? WHERE user_id=? AND scope=? AND idem_key=?', json(waiting), actor.user_id, 'reply.plan', key); audit(store, actor.user_id, 'reply.plan.wait_human', { knowledgeSetId: setId, version: knowledge.version }); return waiting;
      }
      const generated = await deps.providerReplyPlan({ workflowId: id, version, params, idempotencyKey: key, knowledge: { ...knowledge, results: snippets }, targets });
      if (!generated || typeof generated !== 'object' || Array.isArray(generated) || Object.keys(generated).some((field) => !['publicReply', 'privateReply'].includes(field))) throw new AppError(503, 'REPLY_PLAN_INVALID', '模型返回了未支持的字段');
      const publicReply = strictReply(generated?.publicReply, 'publicReply'); const privateReply = strictReply(generated?.privateReply, 'privateReply');
      const contractHash = hashPayload(parseJson<RecordValue>(definition.contract_json, {}));
      const policyFingerprint = hashPayload({ workflowId: id, version, contractHash, knowledgeSetVersion: knowledge.version });
      const policyVersion = Math.max(1, Number.parseInt(policyFingerprint.slice(0, 8), 16) % 1_000_000_000);
      const policyRef = { policyId: `workflow-policy:${id}`, policyVersion, knowledgeSetVersion: knowledge.version };
      const frozenParams = { ...params, publicReply, privateReply, policyRef, knowledgeSetId: knowledge.knowledgeSetId, knowledgeSetVersion: knowledge.version, replyPlan: { publicReply, privateReply, policyRef, knowledgeSetId: knowledge.knowledgeSetId, knowledgeSetVersion: knowledge.version, snippets: snippets.map((item) => ({ chunkId: item.chunkId ?? null, documentId: item.documentId ?? null, title: item.title ?? null, score: item.score ?? null })) } };
      if (Buffer.byteLength(json(frozenParams), 'utf8') > 24_000) throw new AppError(503, 'REPLY_PLAN_INVALID', '冻结话术计划过大');
      const planId = randomId('plan'); const now = store.now(); const issued = { status: 'issued', planId, workflowId: id, version, params: frozenParams, knowledgeSet: { id: knowledge.knowledgeSetId, version: knowledge.version }, issuedAt: now, expiresAt: now + 10 * 60 * 1000, idempotencyKey: key };
      store.transaction(() => { store.run('INSERT INTO workflow_plans(id,user_id,workflow_id,workflow_version,params_json,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)', planId, actor.user_id, id, version, json(frozenParams), 'issued', now, now + 10 * 60 * 1000); store.run('UPDATE idempotency SET status=\'completed\',response_json=? WHERE user_id=? AND scope=? AND idem_key=?', json(issued), actor.user_id, 'reply.plan', key); audit(store, actor.user_id, 'reply.plan.issue', { planId, workflowId: id, version, knowledgeSetId: setId, knowledgeSetVersion: knowledge.version, paramsHash: hashPayload(frozenParams) }); });
      return issued;
    } catch (error) {
      if (error instanceof AppError && !providerUnknown(error)) { store.run('DELETE FROM idempotency WHERE user_id=? AND scope=? AND idem_key=?', actor.user_id, 'reply.plan', key); throw error; }
      const unknown = { status: 'UNKNOWN', reason: 'PROVIDER_UNCERTAIN', idempotencyKey: key };
      store.run('UPDATE idempotency SET status=\'completed\',response_json=? WHERE user_id=? AND scope=? AND idem_key=?', json(unknown), actor.user_id, 'reply.plan', key); audit(store, actor.user_id, 'reply.plan.unknown', { idempotencyKey: key }); return unknown;
    }
  });
}
