import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.js';
import { createOpenAIEmbedding } from '../src/embedding.js';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('OpenAI embedding uses injected fetch and validates the response', async () => {
  let seenUrl = '';
  let seenBody: any;
  const embedding = createOpenAIEmbedding({
    baseUrl: 'http://provider.test/v1/', apiKey: 'secret', model: 'text-embedding-test',
    fetch: async (input, init) => { seenUrl = String(input); seenBody = JSON.parse(String(init?.body)); return response({ data: [{ object: 'embedding', index: 0, embedding: [1, 0, 0] }] }); },
  });
  assert.deepEqual(await embedding.embed('价格'), [1, 0, 0]);
  assert.equal(seenUrl, 'http://provider.test/v1/embeddings');
  assert.deepEqual(seenBody, { model: 'text-embedding-test', input: ['价格'] });
  assert.match(embedding.id ?? '', /text-embedding-test/);
});

test('OpenAI embedding rejects malformed vectors and invalid configuration', async () => {
  const malformed = createOpenAIEmbedding({ baseUrl: 'http://provider.test', apiKey: 'key', model: 'model', fetch: async () => response({ data: [{ index: 0, embedding: [1, null] }] }) });
  await assert.rejects(() => malformed.embed('x'), (error: unknown) => error instanceof AppError && error.code === 'EMBEDDING_PROVIDER_FAILED');
  assert.throws(() => createOpenAIEmbedding({ baseUrl: 'http://provider.test?secret=1', apiKey: 'key', model: 'model' }), (error: unknown) => error instanceof AppError && error.code === 'EMBEDDING_CONFIG_INVALID');
  assert.throws(() => createOpenAIEmbedding({ baseUrl: 'http://provider.test', apiKey: '', model: 'model' }), (error: unknown) => error instanceof AppError && error.code === 'EMBEDDING_CONFIG_INVALID');
});

test('OpenAI embedding maps aborts to a stable timeout error', async () => {
  const embedding = createOpenAIEmbedding({ baseUrl: 'http://provider.test', apiKey: 'key', model: 'model', timeoutMs: 100, fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }); }) });
  await assert.rejects(() => embedding.embed('x'), (error: unknown) => error instanceof AppError && error.code === 'EMBEDDING_TIMEOUT');
});
