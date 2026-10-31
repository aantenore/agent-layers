import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry } from '@agent-layers/core';
import { adapter, createHttpKnowledge } from '../src/index.ts';
import { startKnowledgeService } from './mock.ts';

const ctx = { name: 'docs', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };

test('errorBodyChars and k take effect when set', async () => {
  const svc = await startKnowledgeService((body) => (body.query === 'fail' ? { status: 500, text: 'x'.repeat(50) } : { json: { passages: [] } }));
  try {
    const source = createHttpKnowledge({ url: svc.url, errorBodyChars: 10, k: 7 });
    await assert.rejects(source.search({ query: 'fail' }), (err: Error) => err.message === `knowledge HTTP 500: ${'x'.repeat(10)}`);
    await source.search({ query: 'q' });
    assert.equal(svc.requests[1]!.body.k, 7);
  } finally {
    await svc.close();
  }
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  await registry.create('KnowledgePort', 'http-knowledge', { url: 'http://127.0.0.1:9/search', timeoutMs: '2500' }, ctx);
  await assert.rejects(registry.create('KnowledgePort', 'http-knowledge', { url: 'http://127.0.0.1:9/search', timeoutMs: 0 }, ctx), /timeoutMs/);
  await assert.rejects(registry.create('KnowledgePort', 'http-knowledge', { url: 'http://127.0.0.1:9/search', k: -1 }, ctx), /k/);
  await registry.create('KnowledgePort', 'http-knowledge', { url: 'http://127.0.0.1:9/search', timeoutMs: 'unbounded' }, ctx);
});
