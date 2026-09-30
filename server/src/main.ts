import { buildApp } from './app.js';

const draftTimeout = Number(process.env.DRAFT_TIMEOUT_MS ?? 30000);
const embeddingTimeout = Number(process.env.EMBEDDING_TIMEOUT_MS ?? 15000);
const embeddingBaseUrl = process.env.EMBEDDING_BASE_URL;
const embeddingApiKey = process.env.EMBEDDING_API_KEY;
const embeddingModel = process.env.EMBEDDING_MODEL;
const embeddingConfigured = Boolean(embeddingBaseUrl && embeddingApiKey && embeddingModel);
const app = await buildApp({
  dbPath: process.env.DB_PATH ?? './data/license.sqlite',
  logger: process.env.NODE_ENV !== 'test',
  provider: {
    baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
    model: process.env.OPENAI_COMPATIBLE_MODEL
  },
  ...(embeddingConfigured ? {
    embedding: {
      baseUrl: embeddingBaseUrl!,
      apiKey: embeddingApiKey!,
      model: embeddingModel!,
      timeoutMs: Number.isSafeInteger(embeddingTimeout) && embeddingTimeout > 0 ? embeddingTimeout : 15000,
    }
  } : {}),
  draftTimeoutMs: Number.isSafeInteger(draftTimeout) && draftTimeout > 0 ? draftTimeout : 30000
});
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 18080) });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, async () => { await app.close(); process.exit(0); });
