import type { FastifyInstance } from 'fastify';
import { AppError, badRequest, conflict, forbidden } from './errors.js';
import { hashPayload, randomId } from './security.js';
import { Store } from './store.js';

type RecordValue = Record<string, any>;
type RequestValue = { body?: unknown; params?: unknown; query?: unknown; headers?: Record<string, unknown> };
type AuthFn = (request: RecordValue) => RecordValue;

interface WorkflowRouteDeps {
  store: Store;
  userFromRequest: AuthFn;
  adminFromRequest: AuthFn;
  planner?: (input: RecordValue) => Promise<RecordValue>;
  resultDecider?: (input: RecordValue) => Promise<RecordValue>;
}

const checkpointStatuses = new Set(['RUNNING', 'CHECKPOINT', 'UNKNOWN', 'WAITING_HUMAN', 'PAUSED', 'FAILED', 'COMPLETED', 'STOPPED']);
const transitions: Record<string, Set<string>> = {
  PLANNED: new Set(['RUNNING', 'PAUSED', 'STOPPED']),
  RUNNING: new Set(['RUNNING', 'CHECKPOINT', 'UNKNOWN', 'WAITING_HUMAN', 'PAUSED', 'FAILED', 'COMPLETED', 'STOPPED']),
  CHECKPOINT: new Set(['CHECKPOINT', 'RUNNING', 'PAUSED', 'FAILED', 'STOPPED']),
  UNKNOWN: new Set(['UNKNOWN', 'WAITING_HUMAN', 'RUNNING', 'PAUSED', 'FAILED', 'STOPPED']),
  WAITING_HUMAN: new Set(['WAITING_HUMAN', 'RUNNING', 'PAUSED', 'FAILED', 'STOPPED']),
  PAUSED: new Set(['PAUSED', 'RUNNING', 'FAILED', 'STOPPED']),
  FAILED: new Set(['FAILED']),
  COMPLETED: new Set(['COMPLETED']),
  STOPPED: new Set(['STOPPED']),
};

const json = (value: unknown) => JSON.stringify(value);
const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};
const objectValue = (value: unknown, name: string, maxBytes = 32_000): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest(`${name} 必须是对象`);
  const encoded = json(value);
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw badRequest(`${name} 过大`);
  return value as RecordValue;
};
const stringValue = (value: unknown, name: string, max: number, required = false) => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > max || (required && value.trim().length === 0)) throw badRequest(`${name} 无效`);
  return value;
};
const integerValue = (value: unknown, name: string, min = 0) => {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw badRequest(`${name} 无效`);
  return value as number;
};
const bodyObject = (value: unknown) => objectValue(value, '请求体', 64_000);
const rejectUnknown = (value: RecordValue, allowed: string[]) => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw badRequest('存在未支持的字段', { fields: unknown });
};
const idempotencyKey = (value: unknown) => {
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
  const version = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : stringValue(value, 'version', 40, true);
  if (!version || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(version)) throw badRequest('version 格式无效');
  return version;
};
const planId = (value: unknown) => stringValue(value, 'planId', 160, true) as string;
const normalizeStatus = (value: unknown) => {
  const raw = stringValue(value, 'status', 40, true) as string;
  const aliases: Record<string, string> = { queued: 'PLANNED', running: 'RUNNING', reported: 'CHECKPOINT', waiting_human: 'WAITING_HUMAN', paused: 'PAUSED', stopped: 'STOPPED', failed: 'FAILED', completed: 'COMPLETED' };
  return aliases[raw] ?? raw;
};
const runParams = (value: unknown) => objectValue(value ?? {}, 'params', 24_000);
const workflowContract = (value: unknown) => {
  const contract = objectValue(value, 'contract', 32_000);
  if (!Array.isArray(contract.steps) || contract.steps.length === 0 || contract.steps.length > 100) throw badRequest('contract.steps 必须是 1-100 个步骤');
  contract.steps.forEach((step: unknown, index: number) => {
    if (typeof step === 'string') { if (!step.trim() || step.length > 160) throw badRequest(`contract.steps[${index}] 无效`); return; }
    const item = objectValue(step, `contract.steps[${index}]`, 2_000);
    const stepId = item.stepId ?? item.id;
    if (typeof stepId !== 'string' || !stepId.trim() || stepId.length > 160) throw badRequest(`contract.steps[${index}].stepId 无效`);
    if (item.retryLimit !== undefined && (!Number.isSafeInteger(item.retryLimit) || item.retryLimit < 0 || item.retryLimit > 3)) throw badRequest(`contract.steps[${index}].retryLimit 无效`);
  });
  return contract;
};

function audit(store: Store, actorType: string, actorId: string | null, action: string, targetUserId: string | null, metadata: unknown) {
  store.run('INSERT INTO audit(id,actor_type,actor_id,action,target_user_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', randomId('audit'), actorType, actorId, action, targetUserId, json(metadata), store.now());
}

function settleWorkflowCredit(store: Store, userId: string, actionId: string | null, outcome: 'commit' | 'release', runId: string) {
  if (!actionId) return null;
  const action = store.get<RecordValue>('SELECT * FROM credit_actions WHERE id=? AND user_id=?', actionId, userId);
  if (!action) throw new AppError(409, 'CREDIT_ACTION_NOT_FOUND', '流程绑定的积分动作不存在');
  const metadata = parseJson<RecordValue>(action.metadata_json, {});
  if (metadata.runId !== runId || action.owner !== `workflow:${runId}` && !action.owner.startsWith('workflow:')) {
    throw new AppError(409, 'CREDIT_ACTION_BINDING_INVALID', '流程积分动作绑定无效');
  }
  if (outcome === 'release') {
    if (action.status === 'reserved') store.run("UPDATE credit_actions SET status='released',updated_at=? WHERE id=? AND status='reserved'", store.now(), actionId);
    return store.get<RecordValue>('SELECT * FROM credit_actions WHERE id=?', actionId);
  }
  if (action.status === 'committed') return action;
  if (action.status !== 'reserved') throw new AppError(409, 'CREDIT_ACTION_STATE', '流程积分动作已释放');
  const before = store.get<{ balance: number }>('SELECT COALESCE(sum(delta),0) AS balance FROM ledger WHERE user_id=?', userId)?.balance ?? 0;
  const after = before - action.amount;
  if (after < 0) throw new AppError(409, 'INSUFFICIENT_CREDITS', '积分不足');
  const ledgerId = randomId('ledger');
  store.run('INSERT INTO ledger(id,user_id,delta,balance_after,kind,idempotency_key,payload_hash,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)', ledgerId, userId, -action.amount, after, `workflow:${action.owner}`, `action:${action.id}`, hashPayload({ actionId: action.id, amount: action.amount }), json({ actionId: action.id, runId }), store.now());
  store.run("UPDATE credit_actions SET status='committed',ledger_id=?,updated_at=? WHERE id=? AND status='reserved'", ledgerId, store.now(), actionId);
  return store.get<RecordValue>('SELECT * FROM credit_actions WHERE id=?', actionId);
}

function runResponse(row: RecordValue) {
  return {
    id: row.id,
    userId: row.user_id,
    workflowId: row.workflow_id,
    version: row.workflow_version,
    contract: parseJson(row.contract_json, {}),
    planId: row.plan_id,
    platformAccountId: row.platform_account_id,
    params: parseJson(row.params_json, {}),
    knowledgeSet: row.knowledge_set_id ? { id: row.knowledge_set_id, version: row.knowledge_set_version } : null,
    status: row.status,
    currentStep: row.current_step,
    checkpointVersion: row.checkpoint_version,
    checkpoint: parseJson(row.checkpoint_json, {}),
    failure: parseJson(row.failure_json, null),
    humanWait: parseJson(row.human_wait_json, null),
    recoveryAttempts: row.recovery_attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    lease: row.lease_owner || row.lease_device_id || row.lease_expires_at ? {
      owner: row.lease_owner,
      deviceId: row.lease_device_id,
      expiresAt: row.lease_expires_at,
    } : null,
    creditActionId: row.credit_action_id ?? null,
  };
}

const terminalRunStatuses = new Set(['COMPLETED', 'FAILED', 'STOPPED']);
const leaseTtl = (value: unknown) => {
  if (value === undefined) return 120_000;
  const ttl = integerValue(value, 'ttlMs', 5_000);
  if (ttl > 600_000) throw badRequest('ttlMs 不能超过 600000');
  return ttl;
};

function leaseDevice(actor: RecordValue) {
  const device = stringValue(actor.device_id, 'deviceId', 200, true) as string;
  return { owner: actor.user_id as string, device };
}

/**
 * A run created by an older client may not have a lease. Such runs keep the
 * legacy checkpoint/recovery behavior. Once a lease is present, every mutating
 * workflow operation must come from the same live device lease.
 */
function assertLease(store: Store, row: RecordValue, actor: RecordValue) {
  const hasLease = row.lease_owner !== null && row.lease_owner !== undefined
    || row.lease_device_id !== null && row.lease_device_id !== undefined
    || row.lease_expires_at !== null && row.lease_expires_at !== undefined;
  if (!hasLease) return;
  const identity = leaseDevice(actor);
  if (row.lease_owner !== identity.owner || row.lease_device_id !== identity.device) {
    throw conflict('LEASE_OWNER_MISMATCH', '当前设备不是流程租约持有者');
  }
  if (!Number.isSafeInteger(row.lease_expires_at) || row.lease_expires_at <= store.now()) {
    throw conflict('LEASE_EXPIRED', '流程租约已过期，请重新获取');
  }
}

function leaseResult(run: RecordValue, action: string) {
  return {
    action,
    runId: run.id,
    lease: run.lease_owner || run.lease_device_id || run.lease_expires_at ? {
      owner: run.lease_owner,
      deviceId: run.lease_device_id,
      expiresAt: run.lease_expires_at,
    } : null,
  };
}

function getRun(store: Store, userId: string, runId: string) {
  const row = store.get<RecordValue>('SELECT * FROM workflow_runs WHERE id=? AND user_id=?', runId, userId);
  if (!row) throw new AppError(404, 'RUN_NOT_FOUND', '流程实例不存在');
  return row;
}

interface CheckpointInput {
  status: string;
  stepId?: string;
  cursor?: RecordValue;
  targetState?: RecordValue;
  failure?: RecordValue;
  humanWait?: RecordValue;
  expectedVersion?: number;
  checkpointId?: string;
}

function applyCheckpoint(store: Store, userId: string, runId: string, input: CheckpointInput, actor?: RecordValue) {
  input.status = normalizeStatus(input.status);
  if (!checkpointStatuses.has(input.status)) throw badRequest('checkpoint.status 无效');
  const row = getRun(store, userId, runId);
  if (actor) assertLease(store, row, actor);
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.checkpoint_version) throw conflict('CHECKPOINT_CONFLICT', '检查点版本已变化');
  if (!transitions[row.status]?.has(input.status)) throw conflict('INVALID_RUN_TRANSITION', `不能从 ${row.status} 转为 ${input.status}`);
  if (input.status === 'WAITING_HUMAN' && !input.humanWait) throw badRequest('WAITING_HUMAN 必须提供 humanWait');
  const version = row.checkpoint_version + 1;
  const now = store.now();
  const priorCheckpoint = parseJson<RecordValue>(row.checkpoint_json, {});
  const cursor = input.cursor ?? priorCheckpoint.cursor ?? {};
  const targetState = input.targetState ?? priorCheckpoint.targetState ?? {};
    const checkpointId = input.checkpointId ?? randomId('checkpoint');
    if (store.get('SELECT 1 AS present FROM workflow_checkpoints WHERE id=?', checkpointId)) throw conflict('CHECKPOINT_EXISTS', '检查点已存在');
  return store.transaction(() => {
    const latest = getRun(store, userId, runId);
    if (actor) assertLease(store, latest, actor);
    if (latest.checkpoint_version !== row.checkpoint_version) throw conflict('CHECKPOINT_CONFLICT', '检查点版本已变化');
    store.run('INSERT INTO workflow_checkpoints(id,run_id,version,status,step_id,cursor_json,target_state_json,failure_json,human_wait_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', checkpointId, runId, version, input.status, input.stepId ?? latest.current_step, json(cursor), json(targetState), input.failure ? json(input.failure) : null, input.humanWait ? json(input.humanWait) : null, now);
    const completedAt = ['COMPLETED', 'STOPPED'].includes(input.status) ? now : null;
    store.run('UPDATE workflow_runs SET status=?,current_step=?,checkpoint_version=?,checkpoint_json=?,failure_json=?,human_wait_json=?,updated_at=?,completed_at=? WHERE id=? AND user_id=?', input.status, input.stepId ?? latest.current_step ?? null, version, json({ cursor, targetState }), input.failure ? json(input.failure) : null, input.humanWait ? json(input.humanWait) : null, now, completedAt, runId, userId);
    return getRun(store, userId, runId);
  });
}

function recoverRun(store: Store, userId: string, runId: string, body: RecordValue, actor?: RecordValue) {
  const row = getRun(store, userId, runId);
  if (actor) assertLease(store, row, actor);
  const checksPassed = body.checksPassed === undefined ? 0 : integerValue(body.checksPassed, 'checksPassed', 0);
  const userConfirmed = body.userConfirmed === true;
  if (body.expectedVersion !== undefined && integerValue(body.expectedVersion, 'expectedVersion', 0) !== row.checkpoint_version) throw conflict('CHECKPOINT_CONFLICT', '检查点版本已变化');
  if (row.status === 'PAUSED' && !userConfirmed) throw conflict('RESUME_CONFIRMATION_REQUIRED', '暂停的流程需要用户明确继续');
  if (['WAITING_HUMAN', 'UNKNOWN', 'CHECKPOINT', 'RUNNING'].includes(row.status) && checksPassed < 2) throw conflict('RECOVERY_CHECKS_REQUIRED', '恢复前必须连续通过两次检查');
  if (!['WAITING_HUMAN', 'UNKNOWN', 'CHECKPOINT', 'RUNNING', 'PAUSED', 'PLANNED'].includes(row.status)) throw conflict('INVALID_RUN_TRANSITION', `不能从 ${row.status} 恢复`);
  const now = store.now();
  return store.transaction(() => {
    const latest = getRun(store, userId, runId);
    if (actor) assertLease(store, latest, actor);
    if (latest.checkpoint_version !== row.checkpoint_version) throw conflict('CHECKPOINT_CONFLICT', '检查点版本已变化');
    const version = latest.checkpoint_version + 1;
    const checkpoint = parseJson<RecordValue>(latest.checkpoint_json, {});
    const recovery = { checksPassed, userConfirmed, reason: stringValue(body.reason, 'reason', 500) ?? null };
    store.run('INSERT INTO workflow_checkpoints(id,run_id,version,status,step_id,cursor_json,target_state_json,failure_json,human_wait_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', randomId('checkpoint'), runId, version, 'RUNNING', latest.current_step, json(checkpoint.cursor ?? {}), json(checkpoint.targetState ?? {}), null, null, now);
    store.run("UPDATE workflow_runs SET status='RUNNING',checkpoint_version=?,checkpoint_json=?,failure_json=NULL,human_wait_json=NULL,recovery_attempts=recovery_attempts+1,updated_at=? WHERE id=? AND user_id=?", version, json({ ...checkpoint, recovery }), now, runId, userId);
    return getRun(store, userId, runId);
  });
}

export function registerWorkflowRoutes(app: FastifyInstance, deps: WorkflowRouteDeps) {
  const { store } = deps;
  const user = (request: RequestValue) => deps.userFromRequest(request as RecordValue);
  const admin = (request: RequestValue) => deps.adminFromRequest(request as RecordValue);
  const ensureWorkflowFeature = (actor: RecordValue, id?: string) => {
    const features = parseJson<RecordValue>(actor.features_json, {});
    if (features.workflow === false) throw forbidden('FEATURE_DISABLED', '该账号未开通固定流程功能');
    if (!id) return;
    const entitlement = id.startsWith('video.') ? 'videoSearch' : id.startsWith('comment.') ? 'commentReply' : id.startsWith('live.') ? 'liveInteraction' : null;
    if (entitlement && features[entitlement] === false) throw forbidden('FEATURE_DISABLED', `该账号未开通 ${entitlement} 功能`);
  };
  const platformAccount = (actor: RecordValue, value: unknown) => {
    if (value === undefined) return undefined;
    const id = stringValue(value, 'platformAccountId', 160, true) as string;
    const row = store.get<RecordValue>('SELECT id,platform,account_ref,display_name,status FROM platform_accounts WHERE id=? AND user_id=?', id, actor.user_id);
    if (!row || row.status !== 'active') throw new AppError(404, 'PLATFORM_ACCOUNT_NOT_FOUND', '平台账号不存在或未启用');
    return row;
  };

  app.post('/v1/agent/plan', async (request) => {
    const actor = user(request); ensureWorkflowFeature(actor); const body = bodyObject(request.body);
    rejectUnknown(body, ['intent', 'context', 'idempotencyKey']);
    const intent = stringValue(body.intent, 'intent', 4_000, true) as string;
    const context = body.context === undefined ? {} : objectValue(body.context, 'context', 24_000);
    const key = idempotencyKey(body.idempotencyKey);
    const payload = { intent, context, idempotencyKey: key };
    const old = store.get<RecordValue>('SELECT response_json,payload_hash,status FROM idempotency WHERE user_id=? AND scope=\'agent.plan\' AND idem_key=?', actor.user_id, key);
    if (old) {
      if (old.payload_hash !== hashPayload(payload)) throw conflict('IDEMPOTENCY_CONFLICT', '相同幂等键不能用于不同请求');
      if (old.status === 'completed') return parseJson(old.response_json, null);
      throw conflict('IDEMPOTENCY_PENDING', '相同请求正在处理中');
    }
    if (!deps.planner) throw new AppError(503, 'PLANNER_NOT_CONFIGURED', 'Agent 规划器未配置');
    const catalog = store.all<RecordValue>("SELECT workflow_id,version,name,contract_json FROM workflow_definitions WHERE status='active' ORDER BY workflow_id,version DESC").map((row) => ({ workflowId: row.workflow_id, version: row.version, name: row.name, contract: parseJson(row.contract_json, {}) }));
    if (!catalog.length) throw new AppError(503, 'WORKFLOW_CATALOG_EMPTY', '暂无可用固定流程');
    const result = await deps.planner({ intent, context, catalog });
    const id = workflowId(result.workflowId); const version = workflowVersion(result.version); const params = runParams(result.params); ensureWorkflowFeature(actor, id);
    if (!store.get<RecordValue>("SELECT workflow_id FROM workflow_definitions WHERE workflow_id=? AND version=? AND status='active'", id, version)) throw new AppError(503, 'PLANNER_INVALID_WORKFLOW', '规划器返回了未注册流程');
    const issuedAt = store.now(); const expiresAt = issuedAt + 10 * 60 * 1000;
    const response = { planId: randomId('plan'), workflowId: id, version, params, issuedAt, expiresAt };
    store.transaction(() => {
      store.run('INSERT INTO workflow_plans(id,user_id,workflow_id,workflow_version,params_json,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)', response.planId, actor.user_id, id, version, json(params), 'issued', issuedAt, expiresAt);
      store.run('INSERT INTO idempotency(id,user_id,scope,idem_key,payload_hash,status,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)', randomId('idem'), actor.user_id, 'agent.plan', key, hashPayload(payload), 'completed', json(response), store.now());
      audit(store, 'user', actor.user_id, 'agent.plan', actor.user_id, { workflowId: id, version, paramsHash: hashPayload(params) });
    });
    return response;
  });

  app.post('/v1/platform-accounts', async (request) => {
    const actor = user(request); ensureWorkflowFeature(actor); const body = bodyObject(request.body); rejectUnknown(body, ['platform', 'accountRef', 'displayName']);
    const platform = stringValue(body.platform, 'platform', 40, true) as string; const accountRef = stringValue(body.accountRef, 'accountRef', 200, true) as string; const displayName = stringValue(body.displayName, 'displayName', 200) ?? '';
    const id = randomId('platform'); const now = store.now();
    try { store.run('INSERT INTO platform_accounts(id,user_id,platform,account_ref,display_name,status,created_at,updated_at) VALUES(?,?,?,?,?,\'active\',?,?)', id, actor.user_id, platform, accountRef, displayName, now, now); }
    catch (error) { if (String(error).includes('SQLITE_CONSTRAINT_UNIQUE')) throw conflict('PLATFORM_ACCOUNT_EXISTS', '平台账号已登记'); throw error; }
    audit(store, 'user', actor.user_id, 'platform_account.create', actor.user_id, { platform, accountRefHash: hashPayload(accountRef) });
    return { id, platform, accountRef, displayName, status: 'active', createdAt: now, updatedAt: now };
  });

  app.get('/v1/platform-accounts', async (request) => {
    const actor = user(request); const rows = store.all<RecordValue>('SELECT id,platform,account_ref AS accountRef,display_name AS displayName,status,created_at AS createdAt,updated_at AS updatedAt FROM platform_accounts WHERE user_id=? ORDER BY created_at DESC,id DESC', actor.user_id); return { accounts: rows };
  });

  app.post('/v1/admin/workflows', async (request) => {
    const actor = admin(request); const body = bodyObject(request.body);
    rejectUnknown(body, ['workflowId', 'version', 'name', 'status', 'contract']);
    const id = workflowId(body.workflowId); const version = workflowVersion(body.version); const name = stringValue(body.name, 'name', 200, true) as string;
    const status = body.status ?? 'active'; if (status !== 'active' && status !== 'disabled') throw badRequest('status 无效');
    const contract = workflowContract(body.contract);
    if (store.get('SELECT 1 AS present FROM workflow_definitions WHERE workflow_id=? AND version=?', id, version)) throw conflict('WORKFLOW_VERSION_EXISTS', '流程版本已注册');
    const now = store.now(); const created = store.transaction(() => {
      store.run('INSERT INTO workflow_definitions(workflow_id,version,name,status,contract_json,created_by,created_at) VALUES(?,?,?,?,?,?,?)', id, version, name, status, json(contract), actor.admin_id, now);
      audit(store, 'admin', actor.admin_id, 'workflow.register', null, { workflowId: id, version, status, contractHash: hashPayload(contract) });
      return { workflowId: id, version, name, status, contract, createdAt: now };
    });
    return created;
  });

  app.get('/v1/admin/workflows', async (request) => {
    const actor = admin(request);
    const rows = store.all<RecordValue>('SELECT workflow_id,version,name,status,contract_json,created_by,created_at FROM workflow_definitions ORDER BY workflow_id,version DESC');
    return { workflows: rows.map((row) => ({ workflowId: row.workflow_id, version: row.version, name: row.name, status: row.status, contract: parseJson(row.contract_json, {}), createdBy: row.created_by, createdAt: row.created_at })), actor: actor.admin_id };
  });

  app.get('/v1/workflows', async (request) => {
    const actor = user(request);
    const rows = store.all<RecordValue>("SELECT workflow_id,version,name,status,contract_json,created_at FROM workflow_definitions WHERE status='active' ORDER BY workflow_id,version DESC");
    return { workflows: rows.map((row) => ({ workflowId: row.workflow_id, version: row.version, name: row.name, status: row.status, contract: parseJson(row.contract_json, {}), createdAt: row.created_at })), tenantId: actor.user_id };
  });

  app.post('/v1/knowledge-sets', async (request) => {
    const actor = user(request); const body = bodyObject(request.body); rejectUnknown(body, ['name', 'description', 'metadata']);
    const name = stringValue(body.name, 'name', 100, true) as string; const description = stringValue(body.description, 'description', 1_000) ?? ''; const metadata = objectValue(body.metadata ?? {}, 'metadata', 16_000); const now = store.now(); const id = randomId('knowledge');
    if (store.get('SELECT 1 AS present FROM knowledge_sets WHERE user_id=? AND name=?', actor.user_id, name)) throw conflict('KNOWLEDGE_SET_EXISTS', '同名知识集已存在');
    store.run('INSERT INTO knowledge_sets(id,user_id,name,description,status,version,metadata_json,created_at,updated_at) VALUES(?,?,?,?,\'active\',1,?,?,?)', id, actor.user_id, name, description, json(metadata), now, now);
    audit(store, 'user', actor.user_id, 'knowledge_set.create', actor.user_id, { knowledgeSetId: id, metadataHash: hashPayload(metadata) });
    return { id, name, description, status: 'active', version: 1, metadata, createdAt: now, updatedAt: now };
  });

  app.get('/v1/knowledge-sets', async (request) => {
    const actor = user(request); const rows = store.all<RecordValue>('SELECT id,name,description,status,version,metadata_json,created_at,updated_at FROM knowledge_sets WHERE user_id=? ORDER BY updated_at DESC,id DESC', actor.user_id);
    return { knowledgeSets: rows.map((row) => ({ id: row.id, name: row.name, description: row.description, status: row.status, version: row.version, metadata: parseJson(row.metadata_json, {}), createdAt: row.created_at, updatedAt: row.updated_at })) };
  });

  app.patch('/v1/knowledge-sets/:id', async (request) => {
    const actor = user(request); const id = stringValue((request.params as RecordValue).id, 'knowledgeSetId', 100, true) as string; const body = bodyObject(request.body); rejectUnknown(body, ['name', 'description', 'status', 'metadata']);
    const current = store.get<RecordValue>('SELECT * FROM knowledge_sets WHERE id=? AND user_id=?', id, actor.user_id); if (!current) throw new AppError(404, 'KNOWLEDGE_SET_NOT_FOUND', '知识集不存在');
    const changes: string[] = []; const args: unknown[] = [];
    if (body.name !== undefined) { changes.push('name=?'); args.push(stringValue(body.name, 'name', 100, true)); }
    if (body.description !== undefined) { changes.push('description=?'); args.push(stringValue(body.description, 'description', 1_000, true)); }
    if (body.status !== undefined) { if (body.status !== 'active' && body.status !== 'archived') throw badRequest('status 无效'); changes.push('status=?'); args.push(body.status); }
    let metadata = parseJson<RecordValue>(current.metadata_json, {}); if (body.metadata !== undefined) { metadata = objectValue(body.metadata, 'metadata', 16_000); changes.push('metadata_json=?'); args.push(json(metadata)); }
    if (!changes.length) throw badRequest('没有可更新字段');
    const now = store.now(); args.push(current.version + 1, now, id, actor.user_id); store.run(`UPDATE knowledge_sets SET ${changes.join(',')},version=?,updated_at=? WHERE id=? AND user_id=?`, ...args);
    audit(store, 'user', actor.user_id, 'knowledge_set.update', actor.user_id, { knowledgeSetId: id, metadataHash: hashPayload(metadata) });
    const row = store.get<RecordValue>('SELECT * FROM knowledge_sets WHERE id=? AND user_id=?', id, actor.user_id) as RecordValue;
    return { id: row.id, name: row.name, description: row.description, status: row.status, version: row.version, metadata, createdAt: row.created_at, updatedAt: row.updated_at };
  });

  app.post('/v1/workflow-runs', async (request) => {
    const actor = user(request); ensureWorkflowFeature(actor); const body = bodyObject(request.body); rejectUnknown(body, ['planId', 'workflowId', 'version', 'params', 'knowledgeSetId', 'platformAccountId', 'creditActionId', 'idempotencyKey']);
    const id = workflowId(body.workflowId); const version = workflowVersion(body.version); const plan = planId(body.planId); const params = runParams(body.params); const key = idempotencyKey(body.idempotencyKey); const account = platformAccount(actor, body.platformAccountId); const creditActionId = body.creditActionId === undefined ? null : stringValue(body.creditActionId, 'creditActionId', 160, true) as string;
    ensureWorkflowFeature(actor, id);
    const payload = { planId: plan, workflowId: id, version, params, knowledgeSetId: body.knowledgeSetId ?? null, platformAccountId: account?.id ?? null, creditActionId, idempotencyKey: key };
    const old = store.get<RecordValue>('SELECT response_json,status,payload_hash FROM idempotency WHERE user_id=? AND scope=\'workflow.run\' AND idem_key=?', actor.user_id, key);
    if (old) { if (old.payload_hash !== hashPayload(payload)) throw conflict('IDEMPOTENCY_CONFLICT', '相同幂等键不能用于不同请求'); if (old.status === 'completed') return parseJson(old.response_json, null); throw conflict('IDEMPOTENCY_PENDING', '相同请求正在处理中'); }
    const definition = store.get<RecordValue>("SELECT * FROM workflow_definitions WHERE workflow_id=? AND version=? AND status='active'", id, version); if (!definition) throw new AppError(404, 'WORKFLOW_NOT_FOUND', '流程版本不存在或未启用');
    const issuedPlan = store.get<RecordValue>('SELECT * FROM workflow_plans WHERE id=? AND user_id=?', plan, actor.user_id);
    if (!issuedPlan || issuedPlan.status !== 'issued' || issuedPlan.expires_at <= store.now()) throw new AppError(409, 'PLAN_INVALID', '流程计划不存在、已消费或已过期');
    if (issuedPlan.workflow_id !== id || issuedPlan.workflow_version !== version || issuedPlan.params_json !== json(params)) throw conflict('PLAN_MISMATCH', '流程实例与服务端签发计划不一致');
    if (creditActionId) {
      const action = store.get<RecordValue>('SELECT * FROM credit_actions WHERE id=? AND user_id=?', creditActionId, actor.user_id);
      if (!action || action.status !== 'reserved' || action.owner !== `workflow:${id}`) throw conflict('CREDIT_ACTION_BINDING_INVALID', '流程积分动作必须是当前流程的 reserved 动作');
    }
    let knowledgeSet: RecordValue | undefined;
    if (body.knowledgeSetId !== undefined) { const knowledgeSetId = stringValue(body.knowledgeSetId, 'knowledgeSetId', 100, true) as string; knowledgeSet = store.get<RecordValue>("SELECT id,version,status FROM knowledge_sets WHERE id=? AND user_id=? AND status='active'", knowledgeSetId, actor.user_id); if (!knowledgeSet) throw new AppError(404, 'KNOWLEDGE_SET_NOT_FOUND', '知识集不存在或未启用'); }
    const runId = randomId('run'); const now = store.now();
    const result = store.transaction(() => {
      store.run('INSERT INTO idempotency(id,user_id,scope,idem_key,payload_hash,status,created_at) VALUES(?,?,?,?,?,?,?)', randomId('idem'), actor.user_id, 'workflow.run', key, hashPayload(payload), 'pending', now);
      store.run('UPDATE workflow_plans SET status=\'consumed\',consumed_at=? WHERE id=? AND user_id=? AND status=\'issued\'', now, plan, actor.user_id);
      store.run('INSERT INTO workflow_runs(id,user_id,workflow_id,workflow_version,contract_json,plan_id,platform_account_id,params_json,knowledge_set_id,knowledge_set_version,status,checkpoint_json,idempotency_key,created_at,updated_at,credit_action_id) VALUES(?,?,?,?,?,?,?,?,?, ?,\'PLANNED\',\'{}\',?,?,?,?)', runId, actor.user_id, id, version, definition.contract_json, plan, account?.id ?? null, json(params), knowledgeSet?.id ?? null, knowledgeSet?.version ?? null, key, now, now, creditActionId);
      if (creditActionId) {
        const existing = store.get<RecordValue>('SELECT metadata_json FROM credit_actions WHERE id=?', creditActionId);
        store.run('UPDATE credit_actions SET metadata_json=?,updated_at=? WHERE id=? AND user_id=? AND status=\'reserved\'', json({ ...parseJson(existing?.metadata_json, {}), runId }), now, creditActionId, actor.user_id);
      }
      const row = getRun(store, actor.user_id, runId); const response = { run: runResponse(row) };
      store.run("UPDATE idempotency SET status='completed',response_json=? WHERE user_id=? AND scope='workflow.run' AND idem_key=?", json(response), actor.user_id, key);
      audit(store, 'user', actor.user_id, 'workflow.run.create', actor.user_id, { runId, workflowId: id, version, knowledgeSetId: knowledgeSet?.id ?? null, paramsHash: hashPayload(params) });
      return response;
    });
    return result;
  });

  app.get('/v1/workflow-runs', async (request) => {
    const actor = user(request); const rows = store.all<RecordValue>('SELECT * FROM workflow_runs WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 200', actor.user_id); return { runs: rows.map(runResponse) };
  });

  app.get('/v1/workflow-runs/:id', async (request) => { const actor = user(request); const row = getRun(store, actor.user_id, stringValue((request.params as RecordValue).id, 'runId', 100, true) as string); const checkpoints = store.all<RecordValue>('SELECT id,version,status,step_id AS stepId,cursor_json,target_state_json,failure_json,human_wait_json,created_at AS createdAt FROM workflow_checkpoints WHERE run_id=? ORDER BY version DESC LIMIT 100', row.id).map((x) => ({ ...x, cursor: parseJson(x.cursor_json, {}), targetState: parseJson(x.target_state_json, {}), failure: parseJson(x.failure_json, null), humanWait: parseJson(x.human_wait_json, null) })); return { run: runResponse(row), checkpoints }; });

  app.post('/v1/workflow-runs/:id/lease/acquire', async (request) => {
    const actor = user(request); const body = bodyObject(request.body); rejectUnknown(body, ['ttlMs', 'idempotencyKey']);
    const runId = stringValue((request.params as RecordValue).id, 'runId', 100, true) as string; const identity = leaseDevice(actor); const ttl = leaseTtl(body.ttlMs); const key = idempotencyKey(body.idempotencyKey);
    const payload = { runId, action: 'acquire', owner: identity.owner, deviceId: identity.device, ttlMs: ttl };
    const old = store.get<RecordValue>("SELECT response_json,payload_hash,status FROM idempotency WHERE user_id=? AND scope='workflow.lease.acquire' AND idem_key=?", actor.user_id, key);
    if (old) { if (old.payload_hash !== hashPayload(payload)) throw conflict('IDEMPOTENCY_CONFLICT', '相同幂等键不能用于不同租约请求'); if (old.status === 'completed') return parseJson(old.response_json, null); throw conflict('IDEMPOTENCY_PENDING', '相同请求正在处理中'); }
    const response = store.transaction(() => {
      const current = getRun(store, actor.user_id, runId); const now = store.now();
      if (terminalRunStatuses.has(current.status)) throw conflict('LEASE_TERMINAL', '终态流程不能获取租约');
      const active = current.lease_expires_at && current.lease_expires_at > now;
      if (active && (current.lease_owner !== identity.owner || current.lease_device_id !== identity.device)) throw conflict('LEASE_HELD', '流程租约已被其他设备持有');
      const expiresAt = now + ttl; const action = active ? 'renewed' : 'acquired';
      store.run('UPDATE workflow_runs SET lease_owner=?,lease_device_id=?,lease_expires_at=?,updated_at=? WHERE id=? AND user_id=?', identity.owner, identity.device, expiresAt, now, runId, actor.user_id);
      const updated = getRun(store, actor.user_id, runId); const result = leaseResult(updated, action);
      store.run('INSERT INTO idempotency(id,user_id,scope,idem_key,payload_hash,status,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)', randomId('idem'), actor.user_id, 'workflow.lease.acquire', key, hashPayload(payload), 'completed', json(result), now);
      audit(store, 'user', actor.user_id, `workflow.lease.${action}`, actor.user_id, { runId, deviceIdHash: hashPayload(identity.device), expiresAt });
      return result;
    });
    return response;
  });

  app.post('/v1/workflow-runs/:id/lease/renew', async (request) => {
    const actor = user(request); const body = bodyObject(request.body); rejectUnknown(body, ['ttlMs', 'idempotencyKey']);
    const runId = stringValue((request.params as RecordValue).id, 'runId', 100, true) as string; const identity = leaseDevice(actor); const ttl = leaseTtl(body.ttlMs); const key = idempotencyKey(body.idempotencyKey);
    const payload = { runId, action: 'renew', owner: identity.owner, deviceId: identity.device, ttlMs: ttl };
    const old = store.get<RecordValue>("SELECT response_json,payload_hash,status FROM idempotency WHERE user_id=? AND scope='workflow.lease.renew' AND idem_key=?", actor.user_id, key);
    if (old) { if (old.payload_hash !== hashPayload(payload)) throw conflict('IDEMPOTENCY_CONFLICT', '相同幂等键不能用于不同租约请求'); if (old.status === 'completed') return parseJson(old.response_json, null); throw conflict('IDEMPOTENCY_PENDING', '相同请求正在处理中'); }
    const response = store.transaction(() => {
      const current = getRun(store, actor.user_id, runId); const now = store.now();
      if (terminalRunStatuses.has(current.status)) throw conflict('LEASE_TERMINAL', '终态流程不能续租');
      if (current.lease_owner !== identity.owner || current.lease_device_id !== identity.device) throw conflict('LEASE_OWNER_MISMATCH', '当前设备不是流程租约持有者');
      if (!current.lease_expires_at || current.lease_expires_at <= now) throw conflict('LEASE_EXPIRED', '流程租约已过期，请重新获取');
      const expiresAt = now + ttl; store.run('UPDATE workflow_runs SET lease_expires_at=?,updated_at=? WHERE id=? AND user_id=? AND lease_owner=? AND lease_device_id=? AND lease_expires_at>?', expiresAt, now, runId, actor.user_id, identity.owner, identity.device, now);
      const updated = getRun(store, actor.user_id, runId); const result = leaseResult(updated, 'renewed');
      store.run('INSERT INTO idempotency(id,user_id,scope,idem_key,payload_hash,status,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)', randomId('idem'), actor.user_id, 'workflow.lease.renew', key, hashPayload(payload), 'completed', json(result), now);
      audit(store, 'user', actor.user_id, 'workflow.lease.renewed', actor.user_id, { runId, deviceIdHash: hashPayload(identity.device), expiresAt });
      return result;
    });
    return response;
  });

  app.post('/v1/workflow-runs/:id/lease/release', async (request) => {
    const actor = user(request); const body = bodyObject(request.body); rejectUnknown(body, ['idempotencyKey']);
    const runId = stringValue((request.params as RecordValue).id, 'runId', 100, true) as string; const identity = leaseDevice(actor); const key = idempotencyKey(body.idempotencyKey);
    const payload = { runId, action: 'release', owner: identity.owner, deviceId: identity.device };
    const old = store.get<RecordValue>("SELECT response_json,payload_hash,status FROM idempotency WHERE user_id=? AND scope='workflow.lease.release' AND idem_key=?", actor.user_id, key);
    if (old) { if (old.payload_hash !== hashPayload(payload)) throw conflict('IDEMPOTENCY_CONFLICT', '相同幂等键不能用于不同租约请求'); if (old.status === 'completed') return parseJson(old.response_json, null); throw conflict('IDEMPOTENCY_PENDING', '相同请求正在处理中'); }
    const response = store.transaction(() => {
      const current = getRun(store, actor.user_id, runId);
      if (current.lease_owner && current.lease_device_id && (current.lease_owner !== identity.owner || current.lease_device_id !== identity.device)) throw conflict('LEASE_OWNER_MISMATCH', '当前设备不是流程租约持有者');
      const now = store.now(); store.run('UPDATE workflow_runs SET lease_owner=NULL,lease_device_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND user_id=?', now, runId, actor.user_id);
      const updated = getRun(store, actor.user_id, runId); const result = leaseResult(updated, 'released');
      store.run('INSERT INTO idempotency(id,user_id,scope,idem_key,payload_hash,status,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)', randomId('idem'), actor.user_id, 'workflow.lease.release', key, hashPayload(payload), 'completed', json(result), now);
      audit(store, 'user', actor.user_id, 'workflow.lease.released', actor.user_id, { runId, deviceIdHash: hashPayload(identity.device) });
      return result;
    });
    return response;
  });

  app.post('/v1/workflow-runs/:id/checkpoints', async (request) => {
    const actor = user(request); const body = bodyObject(request.body); rejectUnknown(body, ['status', 'stepId', 'cursor', 'targetState', 'failure', 'humanWait', 'expectedVersion', 'checkpointId']);
    const input: CheckpointInput = { status: stringValue(body.status, 'status', 40, true) as string, stepId: stringValue(body.stepId, 'stepId', 200), cursor: body.cursor === undefined ? undefined : objectValue(body.cursor, 'cursor', 16_000), targetState: body.targetState === undefined ? undefined : objectValue(body.targetState, 'targetState', 16_000), failure: body.failure === undefined ? undefined : objectValue(body.failure, 'failure', 8_000), humanWait: body.humanWait === undefined ? undefined : objectValue(body.humanWait, 'humanWait', 8_000), expectedVersion: body.expectedVersion === undefined ? undefined : integerValue(body.expectedVersion, 'expectedVersion', 0), checkpointId: body.checkpointId === undefined ? undefined : stringValue(body.checkpointId, 'checkpointId', 100, true) };
    const row = applyCheckpoint(store, actor.user_id, stringValue((request.params as RecordValue).id, 'runId', 100, true) as string, input, actor); audit(store, 'user', actor.user_id, 'workflow.checkpoint', actor.user_id, { runId: row.id, version: row.checkpoint_version, status: row.status, stepId: row.current_step }); return { run: runResponse(row) };
  });

  app.post('/v1/workflow-runs/:id/human-wait', async (request) => {
    const actor = user(request); const body = bodyObject(request.body); rejectUnknown(body, ['reason', 'context', 'expiresAt', 'expectedVersion', 'checkpointId']); const reason = stringValue(body.reason, 'reason', 500, true) as string; const context = body.context === undefined ? {} : objectValue(body.context, 'context', 8_000); const expiresAt = body.expiresAt === undefined ? null : integerValue(body.expiresAt, 'expiresAt', store.now() + 1); const runId = stringValue((request.params as RecordValue).id, 'runId', 100, true) as string; const row = applyCheckpoint(store, actor.user_id, runId, { status: 'waiting_human', humanWait: { reason, context, expiresAt }, expectedVersion: body.expectedVersion === undefined ? undefined : integerValue(body.expectedVersion, 'expectedVersion', 0), checkpointId: body.checkpointId === undefined ? undefined : stringValue(body.checkpointId, 'checkpointId', 100, true) }, actor); audit(store, 'user', actor.user_id, 'workflow.human_wait', actor.user_id, { runId: row.id, reasonHash: hashPayload(reason) }); return { run: runResponse(row) };
  });

  const recoverHandler = async (request: RequestValue) => { const actor = user(request); const body = bodyObject(request.body); rejectUnknown(body, ['checksPassed', 'userConfirmed', 'reason', 'expectedVersion']); const row = recoverRun(store, actor.user_id, stringValue((request.params as RecordValue).id, 'runId', 100, true) as string, body, actor); audit(store, 'user', actor.user_id, 'workflow.recover', actor.user_id, { runId: row.id, recoveryAttempts: row.recovery_attempts }); return { run: runResponse(row) }; };
  app.post('/v1/workflow-runs/:id/recover', recoverHandler);
  app.post('/v1/workflow-runs/:id/human-wait/resolve', recoverHandler);
  app.post('/v1/workflow-runs/:id/result-decision', async (request) => {
    const actor = user(request); const body = bodyObject(request.body); rejectUnknown(body, ['status', 'summary', 'idempotencyKey']);
    const runId = stringValue((request.params as RecordValue).id, 'runId', 100, true) as string; const run = getRun(store, actor.user_id, runId); assertLease(store, run, actor); const requestedStatus = stringValue(body.status, 'status', 40, true) as string; const status = normalizeStatus(requestedStatus); if (run.status === 'RUNNING' || status === 'RUNNING') throw conflict('RESULT_DECISION_RUNNING', '运行中的流程不能调用结果决策'); if (status !== run.status) throw conflict('RESULT_STATUS_MISMATCH', '结果状态必须与服务端流程状态一致'); if (!new Set(['FAILED', 'COMPLETED', 'STOPPED', 'UNKNOWN', 'CHECKPOINT', 'WAITING_HUMAN', 'PAUSED']).has(status)) throw badRequest('结果状态无效'); const summary = objectValue(body.summary ?? {}, 'summary', 16_000); const key = idempotencyKey(body.idempotencyKey); const payload = { runId, workflowId: run.workflow_id, version: run.workflow_version, status, summary, idempotencyKey: key };
    const old = store.get<RecordValue>('SELECT response_json,payload_hash,status FROM idempotency WHERE user_id=? AND scope=\'workflow.result-decision\' AND idem_key=?', actor.user_id, key); if (old) { if (old.payload_hash !== hashPayload(payload)) throw conflict('IDEMPOTENCY_CONFLICT', '相同幂等键不能用于不同结果'); if (old.status === 'completed') return parseJson(old.response_json, null); throw conflict('IDEMPOTENCY_PENDING', '相同请求正在处理中'); }
    if (!deps.resultDecider) throw new AppError(503, 'RESULT_DECIDER_NOT_CONFIGURED', '结果决策器未配置');
    const result = await deps.resultDecider({ runId, workflowId: run.workflow_id, version: run.workflow_version, status, summary }); const decision = stringValue(result.decision, 'decision', 40, true) as string; if (!new Set(['continue', 'retry', 'complete', 'wait_human']).has(decision) || Object.keys(result).some((key) => key !== 'decision')) throw new AppError(503, 'RESULT_DECISION_INVALID', '结果决策无效');
    const response = { runId, workflowId: run.workflow_id, version: run.workflow_version, decision };
    store.transaction(() => {
      const outcome = status === 'COMPLETED' ? 'commit' : (status === 'FAILED' || status === 'STOPPED' ? 'release' : null);
      if (outcome) settleWorkflowCredit(store, actor.user_id, run.credit_action_id ?? null, outcome, runId);
      store.run('INSERT INTO idempotency(id,user_id,scope,idem_key,payload_hash,status,response_json,created_at) VALUES(?,?,?,?,?,?,?,?)', randomId('idem'), actor.user_id, 'workflow.result-decision', key, hashPayload(payload), 'completed', json(response), store.now());
      audit(store, 'user', actor.user_id, 'workflow.result-decision', actor.user_id, { runId, decision, creditOutcome: outcome });
    });
    return response;
  });
}
