import { AppError } from './errors.js';

export type DenseEmbedding = number[];
export type SparseEmbedding = Record<string, number>;
export type EmbeddingVector = DenseEmbedding | SparseEmbedding;

export type EmbeddingFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface EmbeddingBackend {
  /** Stable, non-secret identity used to keep vectors from different models apart. */
  readonly id?: string;
  embed(input: string): EmbeddingVector | Promise<EmbeddingVector>;
  embedMany?(inputs: string[]): EmbeddingVector[] | Promise<EmbeddingVector[]>;
}

export interface OpenAIEmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: EmbeddingFetch;
}

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_DIMENSIONS = 16_384;
const MAX_BATCH = 64;

function invalid(message: string): never {
  throw new AppError(500, 'EMBEDDING_CONFIG_INVALID', message);
}

function providerFailure(message: string, details?: unknown): AppError {
  return new AppError(503, 'EMBEDDING_PROVIDER_FAILED', message, details);
}

function normalizeConfig(config: OpenAIEmbeddingConfig) {
  if (!config || typeof config !== 'object') invalid('embedding 配置无效');
  if (typeof config.baseUrl !== 'string' || config.baseUrl.length === 0 || config.baseUrl.length > 2_000) invalid('embedding baseUrl 无效');
  let parsed: URL;
  try { parsed = new URL(config.baseUrl); } catch { invalid('embedding baseUrl 无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) invalid('embedding baseUrl 无效');
  if (typeof config.apiKey !== 'string' || config.apiKey.length === 0 || config.apiKey.length > 4_096 || /[\r\n]/.test(config.apiKey)) invalid('embedding apiKey 无效');
  if (typeof config.model !== 'string' || config.model.trim().length === 0 || config.model.length > 200) invalid('embedding model 无效');
  const timeoutMs = config.timeoutMs === undefined ? 15_000 : config.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) invalid('embedding timeoutMs 无效');
  if (config.fetch !== undefined && typeof config.fetch !== 'function') invalid('embedding fetch 无效');
  const root = config.baseUrl.replace(/\/$/, '');
  const endpoint = root.endsWith('/embeddings') ? root : `${root}/embeddings`;
  return { endpoint, apiKey: config.apiKey, model: config.model, timeoutMs, fetch: config.fetch ?? fetch };
}

function parseEmbedding(value: unknown): DenseEmbedding {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DIMENSIONS || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw providerFailure('embedding 响应向量无效');
  }
  return value as DenseEmbedding;
}

function parseResponse(raw: string, expected: number): DenseEmbedding[] {
  if (raw.length > MAX_RESPONSE_BYTES) throw providerFailure('embedding 响应过大');
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { throw providerFailure('embedding 响应不是有效 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.data) || parsed.data.length !== expected) throw providerFailure('embedding 响应格式无效');
  const result = new Array<DenseEmbedding>(expected);
  const seen = new Set<number>();
  for (const item of parsed.data) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !('embedding' in item)) throw providerFailure('embedding 响应格式无效');
    const index = item.index === undefined ? result.findIndex((entry) => entry === undefined) : item.index;
    if (!Number.isSafeInteger(index) || index < 0 || index >= expected || seen.has(index)) throw providerFailure('embedding 响应索引无效');
    seen.add(index); result[index] = parseEmbedding(item.embedding);
  }
  if (result.some((entry) => !entry)) throw providerFailure('embedding 响应缺少向量');
  const dimension = result[0].length;
  if (result.some((entry) => entry.length !== dimension)) throw providerFailure('embedding 响应维度不一致');
  return result;
}

export class OpenAIEmbeddingBackend implements EmbeddingBackend {
  readonly id: string;
  private readonly config: ReturnType<typeof normalizeConfig>;

  constructor(config: OpenAIEmbeddingConfig) {
    this.config = normalizeConfig(config);
    // Do not include the API key in this identity. It is persisted beside vectors.
    this.id = `openai:${this.config.endpoint}:${this.config.model}`;
  }

  async embed(input: string): Promise<DenseEmbedding> {
    const result = await this.embedMany([input]);
    return result[0];
  }

  async embedMany(inputs: string[]): Promise<DenseEmbedding[]> {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_BATCH) throw providerFailure('embedding 请求批次无效');
    if (inputs.some((input) => typeof input !== 'string' || input.length > 8_000)) throw providerFailure('embedding 输入无效');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await this.config.fetch(this.config.endpoint, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({ model: this.config.model, input: inputs }),
      });
      if (!response.ok) throw providerFailure('embedding provider 请求失败');
      return parseResponse(await response.text(), inputs.length);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw new AppError(503, 'EMBEDDING_TIMEOUT', 'embedding provider 超时');
      throw providerFailure('embedding provider 不可用');
    } finally { clearTimeout(timer); }
  }
}

export function createOpenAIEmbedding(config: OpenAIEmbeddingConfig): EmbeddingBackend {
  return new OpenAIEmbeddingBackend(config);
}
