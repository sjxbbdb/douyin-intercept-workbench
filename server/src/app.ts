import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomId, randomToken, hashPayload, hashToken, hashPassword, verifyPassword } from './security.js';
import { Store } from './store.js';
import { AppError, badRequest, conflict, forbidden, unauthorized } from './errors.js';
import { registerWorkflowRoutes } from './workflow-routes.js';
import { registerKnowledgeRoutes } from './knowledge-routes.js';

export interface AppConfig {
  dbPath?: string;
  host?: string;
  port?: number;
  adminSessionTtlMs?: number;
  userSessionTtlMs?: number;
  draftTimeoutMs?: number;
  rateLimitMax?: number;
  provider?: { baseUrl?: string; apiKey?: string; model?: string };
  logger?: boolean;
}

type AnyRecord = Record<string, any>;
const USER_SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL = 8 * 60 * 60 * 1000;
const DEFAULT_DRAFT_HOLD_TTL = 60 * 1000;
const sourceSet = new Set(['video_comment', 'live_comment', 'live_danmaku']);

const json = (value: unknown) => JSON.stringify(value);
const parseJson = <T>(value: string, fallback: T): T => { try { return JSON.parse(value) as T; } catch { return fallback; } };
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value : null;
const integer = (value: unknown, min = 0) => Number.isSafeInteger(value) && (value as number) >= min ? value as number : null;
const bearer = (header: unknown) => typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;

function bodyObject(value: unknown): AnyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest();
  return value as AnyRecord;
}

function rejectUnknown(value: AnyRecord, allowed: string[]) {
  const names = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !names.has(key));
  if (unknown.length) throw badRequest('存在未支持的字段', { fields: unknown });
}

function boundedString(value: unknown, name: string, max: number, required = false) {
  if (value === undefined && !required) return undefined;
  const result = text(value, max);
  if (result === null || (required && result.trim().length === 0)) throw badRequest(`${name} 无效`);
  return result;
}

function validateIdempotency(value: unknown) {
  const key = text(value, 200);
  if (!key || key.length < 8) throw badRequest('idempotencyKey 必须是 8-200 个字符');
  return key;
}

function audit(store: Store, actorType: string, actorId: string | null, action: string, targetUserId: string | null, metadata: unknown) {
  store.run('INSERT INTO audit(id,actor_type,actor_id,action,target_user_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', randomId('audit'), actorType, actorId, action, targetUserId, json(metadata), store.now());
}

function setting<T>(store: Store, key: string, fallback: T): T {
  const row = store.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key=?', key);
  return row ? parseJson(row.value_json, fallback) : fallback;
}

function saveSetting(store: Store, key: string, value: unknown) {
  store.run('INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at', key, json(value), store.now());
}

function balance(store: Store, userId: string): number {
  const row = store.get<{ balance: number }>('SELECT COALESCE(sum(delta),0) AS balance FROM ledger WHERE user_id=?', userId);
  return row?.balance ?? 0;
}

function appendLedger(store: Store, userId: string, delta: number, kind: string, idempotencyKey: string | null, payloadHash: string | null, metadata: unknown) {
  if (!Number.isSafeInteger(delta)) throw badRequest('积分变动必须是安全范围内的整数');
  const before = balance(store, userId);
  const after = before + delta;
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after)) throw badRequest('积分超出安全范围');
  if (after < 0) throw conflict('INSUFFICIENT_CREDITS', '积分不足');
  const id = randomId('ledger');
  store.run('INSERT INTO ledger(id,user_id,delta,balance_after,kind,idempotency_key,payload_hash,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, userId, delta, after, kind, idempotencyKey ? `${kind}:${idempotencyKey}` : null, payloadHash, json(metadata), store.now());
  return { id, balance: after };
}

function getPricing(store: Store) {
  return setting(store, 'pricing', { evaluateReplyPrice: 1, draftPrice: 2 });
}

function getFeatures(row: AnyRecord, providerConfigured: boolean) {
  const features = parseJson<AnyRecord>(row.features_json ?? '{}', { evaluate: true, draft: false });
  return { evaluate: features.evaluate === true, draft: features.draft === true && providerConfigured, workflow: features.workflow !== false };
}

function recoverExpiredHolds(store: Store) {
  store.transaction(() => {
    const now = store.now();
    const expired = store.all<{ user_id: string; hold_key: string }>("SELECT user_id,hold_key FROM holds WHERE status='held' AND expires_at<=?", now);
    store.run("UPDATE holds SET status='released' WHERE status='held' AND expires_at<=?", now);
    for (const row of expired) if (row.hold_key.startsWith('draft:')) store.run("DELETE FROM idempotency WHERE user_id=? AND scope='draft' AND idem_key=? AND status='pending'", row.user_id, row.hold_key.slice(6));
  });
}

function userFromRequest(store: Store, request: AnyRecord, cfg: AppConfig): AnyRecord & { token: string } {
  const token = bearer(request.headers?.authorization);
  if (!token) throw unauthorized();
  const session = store.get<AnyRecord>('SELECT s.id AS session_id,s.user_id,s.device_id,s.expires_at AS session_expires_at,s.revoked_at AS session_revoked_at,u.username,u.status,u.expires_at AS user_expires_at,u.max_devices,u.features_json,d.id AS device_row_id,d.device_name,d.revoked_at AS device_revoked_at FROM sessions s JOIN users u ON u.id=s.user_id JOIN devices d ON d.user_id=s.user_id AND d.device_id=s.device_id WHERE s.token_hash=?', hashToken(token));
  const now = store.now();
  if (!session) throw unauthorized();
  if (session.status !== 'active') throw forbidden('ACCOUNT_DISABLED', '账号已禁用');
  if (session.session_revoked_at || session.session_expires_at <= now) throw unauthorized(session.session_expires_at <= now ? 'AUTH_EXPIRED' : 'AUTH_INVALID', '认证失败');
  if (session.user_expires_at <= now || session.device_revoked_at) throw session.device_revoked_at ? forbidden('DEVICE_REVOKED', '设备已撤销') : unauthorized('AUTH_EXPIRED', '账号已过期');
  store.run('UPDATE devices SET last_seen_at=? WHERE user_id=? AND device_id=?', now, session.user_id, session.device_id);
  return { ...session, token };
}

function adminFromRequest(store: Store, request: AnyRecord): AnyRecord & { token: string } {
  const token = bearer(request.headers?.authorization);
  if (!token) throw unauthorized();
  const row = store.get<AnyRecord>('SELECT s.*,a.username FROM admin_sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=?', hashToken(token));
  if (!row || row.revoked_at || row.expires_at <= store.now()) throw unauthorized('AUTH_INVALID', '管理员认证失败');
  return { ...row, token };
}

function ensureFeatures(row: AnyRecord, providerConfigured: boolean) {
  const features = getFeatures(row, providerConfigured);
  if (!features.evaluate) throw forbidden('FEATURE_DISABLED', '该账号未开通此功能');
  return features;
}

function eventAndRule(body: AnyRecord) {
  const event = bodyObject(body.event);
  const rule = bodyObject(body.rule ?? {});
  const validated = validateEvent(event);
  rejectUnknown(rule, ['keywords', 'excludeKeywords', 'replyTemplate']);
  if (!Array.isArray(rule.keywords) || !Array.isArray(rule.excludeKeywords)) throw badRequest('rule.keywords/excludeKeywords 必须是数组');
  const keywordList = [...rule.keywords, ...rule.excludeKeywords];
  if (keywordList.length > 100 || keywordList.some((x) => typeof x !== 'string' || x.trim().length === 0 || x.length > 100)) throw badRequest('关键词无效');
  const keywords = rule.keywords as string[];
  const excludeKeywords = rule.excludeKeywords as string[];
  const replyTemplate = boundedString(rule.replyTemplate, 'rule.replyTemplate', 2000, true) as string;
  const { eventId, source, eventText } = validated;
  return { event, rule, eventId, source, eventText, keywords, excludeKeywords, replyTemplate };
}

function validateEvent(event: AnyRecord) {
  rejectUnknown(event, ['id', 'source', 'roomId', 'authorId', 'authorName', 'text', 'observedAt']);
  const eventId = boundedString(event.id, 'event.id', 200, true) as string;
  const source = boundedString(event.source, 'event.source', 40, true) as string;
  const roomId = boundedString(event.roomId, 'event.roomId', 200, true);
  const authorId = boundedString(event.authorId, 'event.authorId', 200, true);
  const authorName = boundedString(event.authorName, 'event.authorName', 200, true);
  const eventText = boundedString(event.text, 'event.text', 4000, true) as string;
  if (!sourceSet.has(source)) throw badRequest('event.source 无效');
  if (!roomId || !authorId || !authorName || !eventText || !Number.isSafeInteger(event.observedAt)) throw badRequest('event 字段无效');
  return { eventId, source, eventText };
}

function renderTemplate(template: string, event: AnyRecord) {
  return template.replace(/\{\{\s*(authorName|text|source)\s*\}\}/g, (_m, key: string) => String(event[key] ?? ''));
}

function idempotentRead(store: Store, userId: string, scope: string, key: string, payload: unknown) {
  const row = store.get<AnyRecord>('SELECT * FROM idempotency WHERE user_id=? AND scope=? AND idem_key=?', userId, scope, key);
  if (!row) return null;
  const payloadHash = hashPayload(payload);
  if (row.payload_hash !== payloadHash) throw conflict('IDEMPOTENCY_CONFLICT', '相同幂等键不能用于不同请求');
  if (row.status === 'completed' && row.response_json) return parseJson(row.response_json, null);
  return { pending: true };
}

function idempotentInsert(store: Store, userId: string, scope: string, key: string, payload: unknown) {
  store.run('INSERT INTO idempotency(id,user_id,scope,idem_key,payload_hash,status,created_at) VALUES(?,?,?,?,?,?,?)', randomId('idem'), userId, scope, key, hashPayload(payload), 'pending', store.now());
}

function idempotentComplete(store: Store, userId: string, scope: string, key: string, response: unknown) {
  store.run('UPDATE idempotency SET status=\'completed\',response_json=? WHERE user_id=? AND scope=? AND idem_key=?', json(response), userId, scope, key);
}

async function providerDraft(cfg: AppConfig, input: AnyRecord): Promise<AnyRecord> {
  const provider = cfg.provider ?? {};
  if (!provider.baseUrl || !provider.apiKey || !provider.model) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'AI provider 未配置');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.draftTimeoutMs ?? 30_000);
  try {
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ model: provider.model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [
        { role: 'system', content: '你是抖音评论意向判断与回复草稿助手。只输出 JSON：matched(boolean), intent(purchase|question|other), confidence(number 0-1), reason(string), reply(string)。不要执行发送。' },
        { role: 'user', content: JSON.stringify(input) }
      ] })
    });
    if (!response.ok) throw new AppError(503, 'PROVIDER_FAILED', 'AI provider 请求失败');
    const raw = await response.text();
    if (raw.length > 100_000) throw new AppError(503, 'PROVIDER_FAILED', 'AI provider 响应过大');
    const data = JSON.parse(raw) as AnyRecord;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new AppError(503, 'PROVIDER_FAILED', 'AI provider 响应无效');
    const parsed = JSON.parse(content) as AnyRecord;
    if (typeof parsed.matched !== 'boolean' || !['purchase', 'question', 'other'].includes(parsed.intent) || typeof parsed.confidence !== 'number' || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1 || typeof parsed.reason !== 'string' || parsed.reason.trim().length === 0 || parsed.reason.length > 1000 || typeof parsed.reply !== 'string' || (parsed.matched && parsed.reply.trim().length === 0) || parsed.reply.length > 2000) throw new AppError(503, 'PROVIDER_FAILED', 'AI provider 输出不符合契约');
    return { matched: parsed.matched, intent: parsed.intent, confidence: parsed.confidence, reason: parsed.reason, reply: parsed.reply };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'PROVIDER_FAILED', error instanceof Error && error.name === 'AbortError' ? 'AI provider 超时' : 'AI provider 不可用');
  } finally { clearTimeout(timer); }
}

async function providerPlan(cfg: AppConfig, input: AnyRecord): Promise<AnyRecord> {
  const provider = cfg.provider ?? {};
  if (!provider.baseUrl || !provider.apiKey || !provider.model) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'AI provider 未配置');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.draftTimeoutMs ?? 30_000);
  try {
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ model: provider.model, temperature: 0, response_format: { type: 'json_object' }, messages: [
        { role: 'system', content: '你是固定流程路由器。只从 catalog 中选择一个 workflowId 和 version，并返回 JSON：workflowId(string), version(integer), params(object)。不要返回 steps、actions、代码或发送内容。' },
        { role: 'user', content: JSON.stringify(input) }
      ] })
    });
    if (!response.ok) throw new AppError(503, 'PROVIDER_FAILED', 'AI provider 请求失败');
    const raw = await response.text(); if (raw.length > 100_000) throw new AppError(503, 'PROVIDER_FAILED', 'AI provider 响应过大');
    const content = (JSON.parse(raw) as AnyRecord).choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new AppError(503, 'PROVIDER_FAILED', 'AI provider 响应无效');
    const parsed = JSON.parse(content) as AnyRecord;
    if (typeof parsed.workflowId !== 'string' || (typeof parsed.version !== 'string' && !Number.isSafeInteger(parsed.version)) || !parsed.params || typeof parsed.params !== 'object' || Array.isArray(parsed.params) || Object.keys(parsed).some((key) => !['workflowId', 'version', 'params'].includes(key))) throw new AppError(503, 'PROVIDER_FAILED', 'AI provider 返回的流程计划无效');
    return { workflowId: parsed.workflowId, version: parsed.version, params: parsed.params };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'PROVIDER_FAILED', error instanceof Error && error.name === 'AbortError' ? 'AI provider 超时' : 'AI provider 不可用');
  } finally { clearTimeout(timer); }
}
async function providerResultDecision(cfg: AppConfig, input: AnyRecord): Promise<AnyRecord> {
  const provider = cfg.provider ?? {}; if (!provider.baseUrl || !provider.apiKey || !provider.model) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'AI provider 未配置');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), cfg.draftTimeoutMs ?? 30_000);
  try {
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` }, body: JSON.stringify({ model: provider.model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: '你是固定流程结果决策器。只输出 JSON：decision 必须是 continue、retry、complete、wait_human 之一。不要返回步骤、工具或代码。' }, { role: 'user', content: JSON.stringify(input) }] }) });
    if (!response.ok) throw new AppError(503, 'PROVIDER_FAILED', 'AI provider 请求失败'); const raw = await response.text(); if (raw.length > 100_000) throw new AppError(503, 'PROVIDER_FAILED', 'AI provider 响应过大'); const content = (JSON.parse(raw) as AnyRecord).choices?.[0]?.message?.content; if (typeof content !== 'string') throw new AppError(503, 'PROVIDER_FAILED', 'AI provider 响应无效'); const parsed = JSON.parse(content) as AnyRecord; if (Object.keys(parsed).length !== 1 || !['continue', 'retry', 'complete', 'wait_human'].includes(parsed.decision)) throw new AppError(503, 'RESULT_DECISION_INVALID', '结果决策无效'); return parsed;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'PROVIDER_FAILED', error instanceof Error && error.name === 'AbortError' ? 'AI provider 超时' : 'AI provider 不可用');
  } finally { clearTimeout(timer); }
}

export async function buildApp(config: AppConfig = {}): Promise<FastifyInstance> {
  const store = new Store(config.dbPath ?? './data/license.sqlite');
  const providerConfigured = Boolean(config.provider?.baseUrl && config.provider.apiKey && config.provider.model);
  saveSetting(store, 'pricing', getPricing(store));
  const app = Fastify({ logger: config.logger ?? false, bodyLimit: 64 * 1024 });
  await app.register(rateLimit, { max: config.rateLimitMax ?? 120, timeWindow: '1 minute' });
  app.decorate('store', store);
  app.addHook('onRequest', async (request) => {
    if (['POST', 'PUT', 'PATCH'].includes(request.method) && request.headers['content-type'] && !request.headers['content-type'].toLowerCase().startsWith('application/json')) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '不支持的媒体类型');
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ ok: false, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
    const frameworkError = error as AnyRecord;
    const frameworkCode = frameworkError.code;
    const statusCode = Number(frameworkError.statusCode);
    if (frameworkCode === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ ok: false, code: 'BODY_TOO_LARGE', message: '请求体过大' });
    if (frameworkCode === 'FST_ERR_CTP_INVALID_JSON_BODY') return reply.code(400).send({ ok: false, code: 'INVALID_JSON', message: '请求 JSON 无效' });
    if (frameworkCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send({ ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: '不支持的媒体类型' });
    if (frameworkCode === 'SQLITE_CONSTRAINT_UNIQUE') return reply.code(409).send({ ok: false, code: 'CONFLICT', message: '资源已存在' });
    if (statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ ok: false, code: statusCode === 429 ? 'RATE_LIMITED' : 'REQUEST_INVALID', message: statusCode === 429 ? '请求过于频繁' : '请求无效' });
    _request.log.error(error);
    return reply.code(500).send({ ok: false, code: 'INTERNAL_ERROR', message: '服务暂时不可用' });
  });

  app.get('/healthz', async (_request, reply) => {
    try { store.get('SELECT 1 AS ok'); return reply.send({ ok: true, db: 'ok' }); }
    catch (error) { app.log.error(error); return reply.code(503).send({ ok: false, db: 'error' }); }
  });

  const dummyPasswordHash = await hashPassword(randomToken());

  app.post('/v1/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = bodyObject(request.body); const username = text(body.username, 100); const password = text(body.password, 256); const deviceId = text(body.deviceId, 200); const deviceName = text(body.deviceName, 200);
    if (!username || !password || !deviceId || !deviceName) throw badRequest('登录参数无效');
    const user = store.get<AnyRecord>('SELECT * FROM users WHERE username=?', username);
    const passwordValid = await verifyPassword(password, user?.password_hash ?? dummyPasswordHash);
    if (!user || !passwordValid) throw unauthorized();
    const now = store.now();
    if (user.status !== 'active') throw forbidden('ACCOUNT_DISABLED', '账号已禁用');
    if (user.expires_at <= now) throw unauthorized('AUTH_EXPIRED', '账号已过期');
    const existing = store.get<AnyRecord>('SELECT * FROM devices WHERE user_id=? AND device_id=?', user.id, deviceId);
    if (!existing) {
      const count = store.get<{ count: number }>('SELECT count(*) AS count FROM devices WHERE user_id=? AND revoked_at IS NULL', user.id)?.count ?? 0;
      if (count >= user.max_devices) throw forbidden('DEVICE_LIMIT', '设备数量已达上限');
      store.run('INSERT INTO devices(id,user_id,device_id,device_name,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?)', randomId('device'), user.id, deviceId, deviceName, now, now);
    } else if (existing.revoked_at) throw forbidden('DEVICE_REVOKED', '设备已撤销');
    else store.run('UPDATE devices SET device_name=?,last_seen_at=? WHERE user_id=? AND device_id=?', deviceName, now, user.id, deviceId);
    const token = randomToken(); const expiresAt = Math.min(user.expires_at, now + (config.userSessionTtlMs ?? USER_SESSION_TTL));
    store.run('INSERT INTO sessions(id,user_id,token_hash,device_id,created_at,expires_at) VALUES(?,?,?,?,?,?)', randomId('session'), user.id, hashToken(token), deviceId, now, expiresAt);
    audit(store, 'user', user.id, 'login', user.id, { deviceIdHash: hashToken(deviceId) });
    return reply.send({ token, expiresAt, user: { id: user.id, username: user.username, expiresAt: user.expires_at, status: user.status }, device: { id: existing?.id ?? store.get<AnyRecord>('SELECT id FROM devices WHERE user_id=? AND device_id=?', user.id, deviceId)?.id, name: deviceName } });
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    const token = bearer(request.headers.authorization); if (token) store.run('UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL', store.now(), hashToken(token));
    return reply.send({ ok: true });
  });

  app.get('/v1/me', async (request) => {
    const user = userFromRequest(store, request, config); const features = getFeatures(user, providerConfigured); const pricing = getPricing(store);
    return { user: { id: user.user_id, username: user.username, expiresAt: user.user_expires_at, status: user.status }, balance: balance(store, user.user_id), features: { ...features, prices: pricing }, device: { id: user.device_row_id, name: user.device_name } };
  });

  app.get('/v1/credits/ledger', async (request) => {
    const user = userFromRequest(store, request, config); const rows = store.all<AnyRecord>('SELECT id,delta,balance_after AS balanceAfter,kind,metadata_json,created_at AS createdAt FROM ledger WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 500', user.user_id);
    return { entries: rows.map((x) => ({ ...x, metadata: parseJson(x.metadata_json, {}) })), balance: balance(store, user.user_id) };
  });

  app.post('/v1/credits/redeem', async (request) => {
    const user = userFromRequest(store, request, config); const body = bodyObject(request.body); const code = text(body.code, 200); const key = validateIdempotency(body.idempotencyKey); if (!code) throw badRequest('兑换码无效');
    const payload = { code, idempotencyKey: key }; const old = idempotentRead(store, user.user_id, 'redeem', key, payload); if (old && !('pending' in old)) return old; if (old?.pending) throw conflict('IDEMPOTENCY_PENDING', '相同请求正在处理中');
    const result = store.transaction(() => {
      idempotentInsert(store, user.user_id, 'redeem', key, payload);
      const row = store.get<AnyRecord>('SELECT * FROM redeem_codes WHERE code_hash=?', hashToken(code));
      if (!row || row.status !== 'active' || row.expires_at <= store.now()) throw conflict('REDEEM_INVALID', '兑换码无效或已过期');
      const entry = appendLedger(store, user.user_id, row.credits, 'redeem', key, hashPayload(payload), { codeHint: row.code_hint });
      store.run("UPDATE redeem_codes SET status='redeemed',redeemed_by=?,redeemed_at=? WHERE id=? AND status='active'", user.user_id, store.now(), row.id);
      const response = { credits: row.credits, charged: 0, balance: entry.balance };
      idempotentComplete(store, user.user_id, 'redeem', key, response); audit(store, 'user', user.user_id, 'redeem', user.user_id, { credits: row.credits, codeHint: row.code_hint }); return response;
    });
    return result;
  });

  app.post('/v1/agent/evaluate', async (request) => {
    const user = userFromRequest(store, request, config); const body = bodyObject(request.body); rejectUnknown(body, ['event', 'rule', 'idempotencyKey']); const parsed = eventAndRule(body); const key = validateIdempotency(body.idempotencyKey); const payload = { event: parsed.event, rule: parsed.rule, idempotencyKey: key };
    ensureFeatures(user, providerConfigured); const old = idempotentRead(store, user.user_id, 'evaluate', key, payload); if (old && !('pending' in old)) return old; if (old?.pending) throw conflict('IDEMPOTENCY_PENDING', '相同请求正在处理中');
    const matched = parsed.keywords.length > 0 && parsed.keywords.some((keyword: string) => parsed.eventText.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())) && !parsed.excludeKeywords.some((keyword: string) => parsed.eventText.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()));
    return store.transaction(() => {
      idempotentInsert(store, user.user_id, 'evaluate', key, payload);
      if (!matched) { const response = { matched: false, reply: null, charged: 0, balance: balance(store, user.user_id), eventId: parsed.eventId }; idempotentComplete(store, user.user_id, 'evaluate', key, response); return response; }
      const price = integer(getPricing(store).evaluateReplyPrice, 0) ?? 1; const activeHolds = store.get<{ total: number }>("SELECT COALESCE(sum(amount),0) AS total FROM holds WHERE user_id=? AND status='held' AND expires_at>?", user.user_id, store.now())?.total ?? 0; if (balance(store, user.user_id) - activeHolds < price) throw conflict('INSUFFICIENT_CREDITS', '积分不足'); const actionId = randomId('action'); const entry = appendLedger(store, user.user_id, -price, 'reply_draft', key, hashPayload(payload), { actionId, eventId: parsed.eventId, source: parsed.source });
      const response = { matched: true, reply: renderTemplate(parsed.replyTemplate, parsed.event), charged: price, balance: entry.balance, eventId: parsed.eventId, actionId }; idempotentComplete(store, user.user_id, 'evaluate', key, response); audit(store, 'user', user.user_id, 'agent.evaluate', user.user_id, { actionId, eventId: parsed.eventId, charged: price }); return response;
    });
  });

  app.post('/v1/agent/draft', async (request) => {
    recoverExpiredHolds(store); const user = userFromRequest(store, request, config); const body = bodyObject(request.body); rejectUnknown(body, ['event', 'businessContext', 'targetCustomer', 'replyInstructions', 'idempotencyKey']); const event = bodyObject(body.event); const validatedEvent = validateEvent(event); const key = validateIdempotency(body.idempotencyKey); const businessContext = boundedString(body.businessContext, 'businessContext', 4000); const targetCustomer = boundedString(body.targetCustomer, 'targetCustomer', 2000); const replyInstructions = boundedString(body.replyInstructions, 'replyInstructions', 2000); const payload = { event, businessContext: businessContext ?? null, targetCustomer: targetCustomer ?? null, replyInstructions: replyInstructions ?? null, idempotencyKey: key }; const old = idempotentRead(store, user.user_id, 'draft', key, payload); if (old && !('pending' in old)) return old; if (old?.pending) throw conflict('IDEMPOTENCY_PENDING', '相同请求正在处理中');
    const eventId = validatedEvent.eventId; const entitlement = parseJson<AnyRecord>(user.features_json ?? '{}', {}); if (entitlement.draft !== true) throw forbidden('FEATURE_DISABLED', '该账号未开通 AI 草稿功能'); if (!providerConfigured) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'AI provider 未配置');
    const price = integer(getPricing(store).draftPrice, 0) ?? 2; const holdKey = `draft:${key}`; const hold = store.transaction(() => { idempotentInsert(store, user.user_id, 'draft', key, payload); const available = balance(store, user.user_id) - (store.get<{ total: number }>("SELECT COALESCE(sum(amount),0) AS total FROM holds WHERE user_id=? AND status='held' AND expires_at>?", user.user_id, store.now())?.total ?? 0); if (available < price) throw conflict('INSUFFICIENT_CREDITS', '积分不足'); const prior = store.get<AnyRecord>('SELECT * FROM holds WHERE user_id=? AND hold_key=?', user.user_id, holdKey); const expiresAt = store.now() + (config.draftTimeoutMs ?? DEFAULT_DRAFT_HOLD_TTL) + 10_000; if (prior?.status === 'held') throw conflict('IDEMPOTENCY_PENDING', '相同请求正在处理中'); if (prior) { store.run("UPDATE holds SET status='held',amount=?,expires_at=? WHERE id=?", price, expiresAt, prior.id); return prior.id; } const id = randomId('hold'); store.run("INSERT INTO holds(id,user_id,owner,hold_key,amount,status,expires_at,created_at) VALUES(?,?,?,?,?,'held',?,?)", id, user.user_id, 'agent.draft', holdKey, price, expiresAt, store.now()); return id; });
    try {
      const result = await providerDraft(config, { event, businessContext, targetCustomer, replyInstructions });
      const fresh = userFromRequest(store, request, config); const freshEntitlement = parseJson<AnyRecord>(fresh.features_json ?? '{}', {}); if (freshEntitlement.draft !== true) throw forbidden('FEATURE_DISABLED', '该账号未开通 AI 草稿功能'); if (!providerConfigured) throw new AppError(503, 'PROVIDER_NOT_CONFIGURED', 'AI provider 未配置'); return store.transaction(() => { if (hold) { const current = store.get<AnyRecord>('SELECT * FROM holds WHERE id=? AND status=\'held\' AND expires_at>?', hold, store.now()); if (!current) throw new AppError(503, 'HOLD_EXPIRED', '积分预留已过期，请重试'); store.run("UPDATE holds SET status='captured' WHERE id=? AND status='held'", hold); } const actionId = randomId('action'); const entry = appendLedger(store, user.user_id, -price, 'ai_draft', key, hashPayload(payload), { actionId, eventId }); const response = { ...result, charged: price, balance: entry.balance, eventId, actionId }; idempotentComplete(store, user.user_id, 'draft', key, response); audit(store, 'user', user.user_id, 'agent.draft', user.user_id, { actionId, eventId, charged: price }); return response; });
    } catch (error) {
      store.transaction(() => { if (hold) store.run("UPDATE holds SET status='released' WHERE id=? AND status='held'", hold); store.run("DELETE FROM idempotency WHERE user_id=? AND scope='draft' AND idem_key=? AND status='pending'", user.user_id, key); });
      throw error;
    }
  });

  app.post('/v1/admin/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request) => {
    const body = bodyObject(request.body); const username = text(body.username, 100); const password = text(body.password, 256); if (!username || !password) throw badRequest('登录参数无效'); const admin = store.get<AnyRecord>('SELECT * FROM admins WHERE username=?', username); const passwordValid = await verifyPassword(password, admin?.password_hash ?? dummyPasswordHash); if (!admin || !passwordValid) throw unauthorized('AUTH_INVALID', '管理员认证失败'); const token = randomToken(); const expiresAt = store.now() + (config.adminSessionTtlMs ?? ADMIN_SESSION_TTL); store.run('INSERT INTO admin_sessions(id,admin_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)', randomId('admin_session'), admin.id, hashToken(token), store.now(), expiresAt); audit(store, 'admin', admin.id, 'login', null, {}); return { token, expiresAt, admin: { id: admin.id, username: admin.username } };
  });
  app.post('/v1/admin/auth/logout', async (request) => { const token = bearer(request.headers.authorization); if (token) store.run('UPDATE admin_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL', store.now(), hashToken(token)); return { ok: true }; });
  app.get('/v1/admin/users', async (request) => { const admin = adminFromRequest(store, request); const users = store.all<AnyRecord>('SELECT id,username,status,expires_at AS expiresAt,max_devices AS maxDevices,created_at AS createdAt,features_json FROM users ORDER BY created_at DESC'); return { users: users.map((u) => ({ ...u, features: parseJson(u.features_json, {}) })), actor: admin.admin_id }; });
  app.post('/v1/admin/users', async (request) => { const admin = adminFromRequest(store, request); const body = bodyObject(request.body); const username = text(body.username, 100) ?? `shop_${randomToken().slice(0, 10)}`; const expiresAt = integer(body.expiresAt ?? (store.now() + 30 * 24 * 60 * 60 * 1000), store.now() + 1); const maxDevices = integer(body.maxDevices ?? 1, 1); if (!expiresAt || !maxDevices) throw badRequest('用户参数无效'); const password = randomBytesPassword(); const passwordHash = await hashPassword(password); const id = randomId('user'); const features = body.features && typeof body.features === 'object' ? { evaluate: body.features.evaluate !== false, draft: body.features.draft === true, workflow: body.features.workflow !== false } : { evaluate: true, draft: false, workflow: true }; store.transaction(() => { store.run('INSERT INTO users(id,username,password_hash,expires_at,max_devices,features_json,created_at) VALUES(?,?,?,?,?,?,?)', id, username, passwordHash, expiresAt, maxDevices, json(features), store.now()); audit(store, 'admin', admin.admin_id, 'user.create', id, { username, expiresAt, maxDevices, features }); }); return { id, username, password, expiresAt, maxDevices, features }; });

  app.patch('/v1/admin/users/:id', async (request) => { const admin = adminFromRequest(store, request); const id = text((request.params as AnyRecord).id, 100); if (!id) throw badRequest('用户 ID 无效'); const body = bodyObject(request.body); const changes: string[] = []; const args: unknown[] = []; if (body.status !== undefined) { if (body.status !== 'active' && body.status !== 'disabled') throw badRequest('status 无效'); changes.push('status=?'); args.push(body.status); } if (body.expiresAt !== undefined) { const v = integer(body.expiresAt, 1); if (!v) throw badRequest('expiresAt 无效'); changes.push('expires_at=?'); args.push(v); } if (body.maxDevices !== undefined) { const v = integer(body.maxDevices, 1); if (!v) throw badRequest('maxDevices 无效'); changes.push('max_devices=?'); args.push(v); } if (body.features !== undefined) { if (!body.features || typeof body.features !== 'object') throw badRequest('features 无效'); changes.push('features_json=?'); args.push(json({ evaluate: body.features.evaluate !== false, draft: body.features.draft === true, workflow: body.features.workflow !== false })); } if (!changes.length) throw badRequest('没有可更新字段'); args.push(id); const result = store.transaction(() => { const updated = store.run(`UPDATE users SET ${changes.join(',')} WHERE id=?`, ...args); if (!updated.changes) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在'); if (body.status === 'disabled') store.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', store.now(), id); audit(store, 'admin', admin.admin_id, 'user.update', id, { fields: changes.map((x) => x.split('=')[0]) }); return store.get<AnyRecord>('SELECT id,username,status,expires_at AS expiresAt,max_devices AS maxDevices,features_json FROM users WHERE id=?', id); }); return { ...result, features: parseJson(result?.features_json ?? '{}', {}) }; });
  app.post('/v1/admin/users/:id/renew', async (request) => { const admin = adminFromRequest(store, request); const id = text((request.params as AnyRecord).id, 100); const body = bodyObject(request.body); const expiresAt = integer(body.expiresAt, store.now() + 1); if (!id || !expiresAt) throw badRequest('续期参数无效'); const result = store.run('UPDATE users SET expires_at=?,status=\'active\' WHERE id=?', expiresAt, id); if (!result.changes) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在'); audit(store, 'admin', admin.admin_id, 'user.renew', id, { expiresAt }); return { id, expiresAt, status: 'active' }; });
  app.post('/v1/admin/users/:id/disable', async (request) => { const admin = adminFromRequest(store, request); const id = text((request.params as AnyRecord).id, 100); if (!id) throw badRequest('用户 ID 无效'); const result = store.transaction(() => { const changed = store.run("UPDATE users SET status='disabled' WHERE id=?", id); if (!changed.changes) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在'); store.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', store.now(), id); audit(store, 'admin', admin.admin_id, 'user.disable', id, {}); return { id, status: 'disabled' }; }); return result; });
  app.post('/v1/admin/users/:id/reset-password', async (request) => { const admin = adminFromRequest(store, request); const id = text((request.params as AnyRecord).id, 100); if (!id) throw badRequest('用户 ID 无效'); const password = randomBytesPassword(); const passwordHash = await hashPassword(password); const result = store.transaction(() => { const changed = store.run('UPDATE users SET password_hash=? WHERE id=?', passwordHash, id); if (!changed.changes) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在'); store.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', store.now(), id); audit(store, 'admin', admin.admin_id, 'user.reset_password', id, {}); return { id, password }; }); return result; });
  app.get('/v1/admin/users/:id/devices', async (request) => { const admin = adminFromRequest(store, request); const id = text((request.params as AnyRecord).id, 100); if (!id) throw badRequest('用户 ID 无效'); return { devices: store.all<AnyRecord>('SELECT id,device_id AS deviceId,device_name AS deviceName,first_seen_at AS firstSeenAt,last_seen_at AS lastSeenAt,revoked_at AS revokedAt FROM devices WHERE user_id=? ORDER BY first_seen_at DESC', id), actor: admin.admin_id }; });
  app.post('/v1/admin/users/:id/devices/:deviceId/revoke', async (request) => { const admin = adminFromRequest(store, request); const params = request.params as AnyRecord; const id = text(params.id, 100); const deviceId = text(params.deviceId, 200); if (!id || !deviceId) throw badRequest('设备参数无效'); const result = store.transaction(() => { const changed = store.run('UPDATE devices SET revoked_at=? WHERE user_id=? AND device_id=? AND revoked_at IS NULL', store.now(), id, deviceId); if (!changed.changes) throw new AppError(404, 'DEVICE_NOT_FOUND', '设备不存在'); store.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND device_id=? AND revoked_at IS NULL', store.now(), id, deviceId); audit(store, 'admin', admin.admin_id, 'device.revoke', id, { deviceIdHash: hashToken(deviceId) }); return { id, deviceId, revoked: true }; }); return result; });
  app.post('/v1/admin/users/:id/credits', async (request) => { const admin = adminFromRequest(store, request); const id = text((request.params as AnyRecord).id, 100); const body = bodyObject(request.body); const amount = integer(body.amount, 1); const key = validateIdempotency(body.idempotencyKey); if (!id || !amount) throw badRequest('充值参数无效'); const payload = { amount, reason: text(body.reason, 200) ?? null, idempotencyKey: key }; const old = idempotentRead(store, id, 'admin.credit', key, payload); if (old && !('pending' in old)) return old; const result = store.transaction(() => { idempotentInsert(store, id, 'admin.credit', key, payload); const entry = appendLedger(store, id, amount, 'admin_credit', key, hashPayload(payload), { reason: payload.reason }); const response = { amount, balance: entry.balance }; idempotentComplete(store, id, 'admin.credit', key, response); audit(store, 'admin', admin.admin_id, 'credits.add', id, { amount, reason: payload.reason }); return response; }); return result; });
  app.post('/v1/admin/redeem-codes', async (request) => { const admin = adminFromRequest(store, request); const body = bodyObject(request.body); const credits = integer(body.credits, 1); const expiresAt = integer(body.expiresAt ?? (store.now() + 365 * 24 * 60 * 60 * 1000), store.now() + 1); const count = integer(body.count ?? 1, 1); if (!credits || !expiresAt || !count || count > 1000) throw badRequest('兑换码参数无效'); const codes = store.transaction(() => { const output: AnyRecord[] = []; for (let i = 0; i < count; i++) { const code = `DC-${randomToken().slice(0, 20).toUpperCase()}`; store.run('INSERT INTO redeem_codes(id,code_hash,code_hint,credits,expires_at) VALUES(?,?,?,?,?)', randomId('code'), hashToken(code), `${code.slice(0, 7)}…`, credits, expiresAt); output.push({ code, credits, expiresAt }); } audit(store, 'admin', admin.admin_id, 'redeem.create', null, { count, credits, expiresAt }); return output; }); return { codes }; });
  app.get('/v1/admin/users/:id/ledger', async (request) => { const admin = adminFromRequest(store, request); const id = text((request.params as AnyRecord).id, 100); if (!id) throw badRequest('用户 ID 无效'); const rows = store.all<AnyRecord>('SELECT id,delta,balance_after AS balanceAfter,kind,metadata_json,created_at AS createdAt FROM ledger WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 1000', id); return { entries: rows.map((x) => ({ ...x, metadata: parseJson(x.metadata_json, {}) })), balance: balance(store, id), actor: admin.admin_id }; });
  app.put('/v1/admin/settings/pricing', async (request) => { const admin = adminFromRequest(store, request); const body = bodyObject(request.body); const evaluateReplyPrice = integer(body.evaluateReplyPrice, 0); const draftPrice = integer(body.draftPrice, 0); if (evaluateReplyPrice === null || draftPrice === null) throw badRequest('价格必须是非负整数'); saveSetting(store, 'pricing', { evaluateReplyPrice, draftPrice }); audit(store, 'admin', admin.admin_id, 'pricing.update', null, { evaluateReplyPrice, draftPrice }); return { evaluateReplyPrice, draftPrice }; });
  const creditActionResponse = (row: AnyRecord) => ({ id: row.id, actionKey: row.action_key, owner: row.owner, amount: row.amount, status: row.status, ledgerId: row.ledger_id, metadata: parseJson(row.metadata_json, {}), createdAt: row.created_at, updatedAt: row.updated_at });
  app.post('/v1/credits/actions/reserve', async (request) => {
    const user = userFromRequest(store, request, config); const body = bodyObject(request.body); rejectUnknown(body, ['actionKey', 'owner', 'amount', 'metadata']);
    const actionKey = validateIdempotency(body.actionKey); const owner = boundedString(body.owner, 'owner', 120, true) as string; const amount = integer(body.amount, 1); if (!amount) throw badRequest('amount 无效'); const metadata = body.metadata === undefined ? {} : bodyObject(body.metadata);
    const action = store.transaction(() => { const existing = store.get<AnyRecord>('SELECT * FROM credit_actions WHERE user_id=? AND action_key=?', user.user_id, actionKey); if (existing) { if (existing.owner !== owner || existing.amount !== amount || existing.metadata_json !== json(metadata)) throw conflict('IDEMPOTENCY_CONFLICT', '相同 actionKey 不能用于不同动作'); return existing; } const reserved = store.get<{ total: number }>("SELECT COALESCE(sum(amount),0) AS total FROM credit_actions WHERE user_id=? AND status='reserved'", user.user_id)?.total ?? 0; if (balance(store, user.user_id) - reserved < amount) throw conflict('INSUFFICIENT_CREDITS', '积分不足'); const id = randomId('credit_action'); const now = store.now(); store.run("INSERT INTO credit_actions(id,user_id,action_key,owner,amount,status,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,'reserved',?,?,?)", id, user.user_id, actionKey, owner, amount, json(metadata), now, now); audit(store, 'user', user.user_id, 'credits.reserve', user.user_id, { actionId: id, owner, amount }); return store.get<AnyRecord>('SELECT * FROM credit_actions WHERE id=?', id)!; });
    return { action: creditActionResponse(action), balance: balance(store, user.user_id) };
  });
  app.post('/v1/credits/actions/:id/commit', async (request) => {
    const user = userFromRequest(store, request, config); const id = text((request.params as AnyRecord).id, 160); if (!id) throw badRequest('actionId 无效');
    const result = store.transaction(() => { const row = store.get<AnyRecord>('SELECT * FROM credit_actions WHERE id=? AND user_id=?', id, user.user_id); if (!row) throw new AppError(404, 'CREDIT_ACTION_NOT_FOUND', '积分动作不存在'); if (row.status === 'committed') return { row, balance: balance(store, user.user_id) }; if (row.status !== 'reserved') throw conflict('CREDIT_ACTION_STATE', '积分动作已释放'); const entry = appendLedger(store, user.user_id, -row.amount, `credit_action:${row.owner}`, `action:${row.id}`, hashPayload({ actionId: row.id, amount: row.amount }), { actionId: row.id, owner: row.owner, ...parseJson(row.metadata_json, {}) }); store.run("UPDATE credit_actions SET status='committed',ledger_id=?,updated_at=? WHERE id=? AND status='reserved'", entry.id, store.now(), row.id); const next = store.get<AnyRecord>('SELECT * FROM credit_actions WHERE id=?', row.id)!; audit(store, 'user', user.user_id, 'credits.commit', user.user_id, { actionId: row.id, ledgerId: entry.id, amount: row.amount }); return { row: next, balance: entry.balance }; });
    return { action: creditActionResponse(result.row), balance: result.balance };
  });
  app.post('/v1/credits/actions/:id/release', async (request) => {
    const user = userFromRequest(store, request, config); const id = text((request.params as AnyRecord).id, 160); if (!id) throw badRequest('actionId 无效');
    const result = store.transaction(() => { const row = store.get<AnyRecord>('SELECT * FROM credit_actions WHERE id=? AND user_id=?', id, user.user_id); if (!row) throw new AppError(404, 'CREDIT_ACTION_NOT_FOUND', '积分动作不存在'); if (row.status === 'released') return row; if (row.status === 'committed') throw conflict('CREDIT_ACTION_STATE', '已提交的积分动作不能释放'); store.run("UPDATE credit_actions SET status='released',updated_at=? WHERE id=? AND status='reserved'", store.now(), row.id); audit(store, 'user', user.user_id, 'credits.release', user.user_id, { actionId: row.id, amount: row.amount }); return store.get<AnyRecord>('SELECT * FROM credit_actions WHERE id=?', row.id)!; });
    return { action: creditActionResponse(result), balance: balance(store, user.user_id) };
  });
  app.get('/v1/admin/audit', async (request) => { const admin = adminFromRequest(store, request); const rows = store.all<AnyRecord>('SELECT id,actor_type AS actorType,actor_id AS actorId,action,target_user_id AS targetUserId,metadata_json AS metadata,created_at AS createdAt FROM audit ORDER BY id DESC LIMIT 1000'); return { entries: rows.map((x) => ({ ...x, metadata: parseJson(x.metadata, {}) })), actor: admin.admin_id }; });

  registerWorkflowRoutes(app, {
    store,
    userFromRequest: (request) => userFromRequest(store, request, config),
    adminFromRequest: (request) => adminFromRequest(store, request),
    planner: (input) => providerPlan(config, input),
    resultDecider: (input) => providerResultDecision(config, input),
  });
  registerKnowledgeRoutes(app, {
    store,
    userFromRequest: (request) => userFromRequest(store, request, config),
  });

  app.addHook('onClose', async () => store.close());
  return app;
}

function randomBytesPassword() { return randomToken().slice(0, 22); }
