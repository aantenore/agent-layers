import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

const base = (process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/+$/, '');
const model = process.env.LLM_MODEL ?? 'qwen3:4b';

test('live: conformance against a real endpoint', { timeout: 180_000 }, async (t) => {
  let ids: string[];
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return t.skip(`${base}/models answered HTTP ${res.status}`);
    ids = ((await res.json() as { data?: { id: string }[] }).data ?? []).map((m) => m.id);
  } catch {
    return t.skip(`${base} is not reachable`);
  }
  if (!ids.includes(model)) return t.skip(`model ${model} is not available at ${base}`);
  const report = await checkAdapter(adapter, {
    options: { baseUrl: base, ...(process.env.LLM_API_KEY ? { apiKey: process.env.LLM_API_KEY } : {}) },
    fixtures: { model, timeoutMs: 120_000 },
  });
  assert.deepEqual(report.failures, []);
});
