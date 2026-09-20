import type { FastifyInstance } from 'fastify';
import { AppError, badRequest } from './errors.js';
import { hashPayload, randomId } from './security.js';
import { Store } from './store.js';

type Row = Record<string, any>;
type Request = { body?: unknown; params?: unknown; query?: unknown };
type Auth = (request: Row) => Row;

const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const object = (value: unknown, name: string, max = 32_000): Row => { if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(json(value), 'utf8') > max) throw badRequest(`${name} 无效或过大`); return value as Row; };
const text = (value: unknown, name: string, max: number, required = false) => { if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw badRequest(`${name} 无效`); return value; };
const integer = (value: unknown, name: string, min: number, max: number) => { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw badRequest(`${name} 无效`); return value as number; };
const reject = (value: Row, allowed: string[]) => { const unknown = Object.keys(value).filter((key) => !allowed.includes(key)); if (unknown.length) throw badRequest('存在未支持的字段', { fields: unknown }); };

// Deliberately simple default backend: exact Unicode Han characters and ASCII
// words become a sparse bag vector. This is deterministic and testable, not a
// production semantic embedding model.
export interface EmbeddingBackend { embed(input: string): Record<string, number>; }
export const bagOfTokens: EmbeddingBackend = { embed(input) { const out: Record<string, number> = {}; const tokens = input.toLocaleLowerCase().match(/[\p{Script=Han}]|[a-z0-9]+/gu) ?? []; for (const token of tokens) out[token] = (out[token] ?? 0) + 1; return out; } };
function cosine(a: Record<string, number>, b: Record<string, number>) { let dot = 0; let na = 0; let nb = 0; for (const value of Object.values(a)) na += value * value; for (const value of Object.values(b)) nb += value * value; for (const [key, value] of Object.entries(a)) dot += value * (b[key] ?? 0); return na && nb ? dot / Math.sqrt(na * nb) : 0; }
function chunks(content: string, size = 500) { const result: string[] = []; for (let i = 0; i < content.length; i += size) result.push(content.slice(i, i + size)); return result; }

export function registerKnowledgeRoutes(app: FastifyInstance, deps: { store: Store; userFromRequest: Auth; embedding?: EmbeddingBackend }) {
  const { store } = deps; const embedding = deps.embedding ?? bagOfTokens;
  const user = (request: Request) => deps.userFromRequest(request as Row);
  const getSet = (actor: Row, id: unknown) => { const setId = text(id, 'knowledgeSetId', 100, true) as string; const row = store.get<Row>('SELECT id,name,status,version FROM knowledge_sets WHERE id=? AND user_id=?', setId, actor.user_id); if (!row) throw new AppError(404, 'KNOWLEDGE_SET_NOT_FOUND', '知识集不存在'); if (row.status !== 'active') throw new AppError(409, 'KNOWLEDGE_SET_INACTIVE', '知识集未启用'); return row; };

  app.post('/v1/knowledge-documents', async (request) => {
    const actor = user(request); const body = object(request.body, '请求体', 240_000); reject(body, ['knowledgeSetId', 'title', 'content', 'metadata']); const set = getSet(actor, body.knowledgeSetId); const title = text(body.title, 'title', 300, true) as string; const content = text(body.content, 'content', 200_000, true) as string; const metadata = body.metadata === undefined ? {} : object(body.metadata, 'metadata', 16_000); const parts = chunks(content); if (parts.length > 400) throw badRequest('文档分块数量过多'); const documentId = randomId('document'); const now = store.now();
    store.transaction(() => { store.run('INSERT INTO knowledge_documents(id,user_id,knowledge_set_id,knowledge_set_version,title,content_hash,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)', documentId, actor.user_id, set.id, set.version, title, hashPayload(content), json(metadata), now); parts.forEach((part, ordinal) => store.run('INSERT INTO knowledge_chunks(id,document_id,user_id,knowledge_set_id,knowledge_set_version,ordinal,text,vector_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)', randomId('chunk'), documentId, actor.user_id, set.id, set.version, ordinal, part, json(embedding.embed(part)), now)); });
    return { document: { id: documentId, knowledgeSetId: set.id, version: set.version, title, chunkCount: parts.length, metadata, createdAt: now } };
  });

  app.get('/v1/knowledge-documents', async (request) => { const actor = user(request); const query = object(request.query ?? {}, 'query', 2_000); const set = getSet(actor, query.knowledgeSetId); const version = query.version === undefined ? set.version : integer(query.version, 'version', 1, set.version); const rows = store.all<Row>('SELECT id,title,knowledge_set_version AS version,content_hash AS contentHash,metadata_json,created_at AS createdAt FROM knowledge_documents WHERE user_id=? AND knowledge_set_id=? AND knowledge_set_version=? ORDER BY created_at DESC,id DESC', actor.user_id, set.id, version); return { knowledgeSetId: set.id, version, documents: rows.map((row) => ({ ...row, metadata: parse(row.metadata_json, {}) })) }; });

  app.post('/v1/knowledge-retrieve', async (request) => {
    const actor = user(request); const body = object(request.body, '请求体', 8_000); reject(body, ['knowledgeSetId', 'version', 'query', 'topK']); const set = getSet(actor, body.knowledgeSetId); const version = body.version === undefined ? set.version : integer(body.version, 'version', 1, set.version); const query = text(body.query, 'query', 4_000, true) as string; const topK = body.topK === undefined ? 5 : integer(body.topK, 'topK', 1, 20); const vector = embedding.embed(query); const rows = store.all<Row>('SELECT c.id,c.document_id,c.text,c.ordinal,c.vector_json,c.knowledge_set_version,d.title,d.metadata_json FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE c.user_id=? AND c.knowledge_set_id=? AND c.knowledge_set_version=?', actor.user_id, set.id, version); const results = rows.map((row) => ({ chunkId: row.id, documentId: row.document_id, title: row.title, text: row.text, ordinal: row.ordinal, score: cosine(vector, parse(row.vector_json, {})), metadata: parse(row.metadata_json, {}) })).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId)).slice(0, topK); return { knowledgeSetId: set.id, version, backend: 'deterministic-token-bag', results }; });
}
