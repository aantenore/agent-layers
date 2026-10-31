import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry } from '@agent-layers/core';
import { adapter, createExpectedEval } from '../src/index.ts';

const ctx = { name: 'expected', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const long = 'abcdefghijklmnopqrstuvwxyz';

test('maxQuoteChars shortens the quoted answer', async () => {
  const reasonOf = async (maxQuoteChars?: number) => (await createExpectedEval({ mode: 'equals', ...(maxQuoteChars ? { maxQuoteChars } : {}) }).score({ id: 'c', input: 'q', expected: long }, { runId: 'r', output: 'no', status: 'completed' }))[0]!.reason;
  assert.equal(await reasonOf(), `equals failed for "${long}"`);
  assert.equal(await reasonOf(10), 'equals failed for "abcdefg..."');
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  await registry.create('EvaluatorPort', 'expected-eval', { maxQuoteChars: '80' }, ctx);
  for (const bad of [0, 3, 'unbounded']) {
    await assert.rejects(registry.create('EvaluatorPort', 'expected-eval', { maxQuoteChars: bad }, ctx), /maxQuoteChars/, String(bad));
  }
});
