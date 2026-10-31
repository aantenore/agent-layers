import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reinloop } from '../../../lib/reinloop.mjs';

try { process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env')); } catch { /* .env is optional */ }

const baseUrl = (process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, '');
const model = process.env.LLM_MODEL ?? 'qwen3:4b';
const env = { ...process.env, OLLAMA_BASE_URL: baseUrl };
const params = { maxTokens: 1024, temperature: 0 };

/** Returns undefined when the model is served, otherwise the reason to skip. */
async function skipReason() {
  let ids;
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return `LLM endpoint ${baseUrl} answered HTTP ${res.status}`;
    ids = ((await res.json()).data ?? []).map((m) => m.id);
  } catch {
    return `Ollama not reachable at ${baseUrl}; start it with "ollama serve"`;
  }
  if (!ids.includes(model)) return `model "${model}" is not available at ${baseUrl}; run "ollama pull ${model}"`;
}

test('L1: the Ollama preset passes the provider conformance check', { timeout: 240_000 }, async (t) => {
  const reason = await skipReason();
  if (reason) return t.skip(`SKIPPED: ${reason}`);
  if (typeof reinloop.checkProvider !== 'function') return t.skip('SKIPPED: this reinloop has no checkProvider; set REINLOOP_SRC to a newer checkout');

  const ref = reinloop.resolveModel(`ollama/${model}`, env);
  const failures = await reinloop.checkProvider(ref.provider, { model: ref.model, params });
  assert.deepEqual(failures, []);
});

test('L1: an agent run with one tool call completes', { timeout: 240_000 }, async (t) => {
  const reason = await skipReason();
  if (reason) return t.skip(`SKIPPED: ${reason}`);

  let calls = 0;
  const add = reinloop.defineTool({
    name: 'add',
    description: 'Add two integers and return the sum.',
    risk: 'read',
    schema: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] },
    run: ({ a, b }) => (calls++, String(a + b)),
  });
  const agent = reinloop.agent({
    model: reinloop.resolveModel(`ollama/${model}`, env),
    params,
    instructions: 'Use the add tool for any addition, then state the result.',
    tools: [add],
  });
  const result = await agent.run('What is 17 + 25?');
  assert.equal(result.status, 'completed', `status ${result.status}: ${result.reason ?? ''}`);
  assert.ok(calls >= 1, 'the model never called the tool');
  assert.match(result.output, /42/);
});
