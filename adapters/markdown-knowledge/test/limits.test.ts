import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry } from '@agent-layers/core';
import { adapter, createMarkdownKnowledge } from '../src/index.ts';
import { FILES, tempDir } from './helpers.ts';

const actx = { name: 'kb', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };

test('k sets how many passages a query without k returns; the default is 4', async () => {
  const { dir, cleanup } = await tempDir(FILES);
  try {
    const query = 'Quillmere harbour town tide gate lighthouse beacon salt pans';
    assert.equal((await createMarkdownKnowledge({ dir: '.' }, { cwd: dir }).search({ text: query })).length, 4);
    assert.equal((await createMarkdownKnowledge({ dir: '.', k: 2 }, { cwd: dir }).search({ text: query })).length, 2);
    assert.equal((await createMarkdownKnowledge({ dir: '.', k: 2 }, { cwd: dir }).search({ text: query, k: 3 })).length, 3);
  } finally {
    await cleanup();
  }
});

test('k from ${env:...} is coerced to a number; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  const make = (options: Record<string, unknown>) => registry.create('KnowledgePort', 'markdown-knowledge', { dir: '.', ...options }, actx);
  await make({ k: '6' });
  await assert.rejects(make({ k: 0 }), /options\.k/);
  await assert.rejects(make({ k: -2 }), /options\.k/);
  await assert.rejects(make({ k: 'unbounded' }), /options\.k/);
});
