import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compose, loadConfig, type EvalCase, type ResolvedConfig, type Stack } from '@agent-layers/core';

const config = fileURLToPath(new URL('../agent-layers.json', import.meta.url));
const cases = (await readFile(new URL('../evals/smoke.jsonl', import.meta.url), 'utf8'))
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as EvalCase);

/** The caller: AGENT_LAYERS_TOKEN, or the dev token of the static-identity options in the config. Anonymous without one. */
async function caller(stack: Stack, resolved: ResolvedConfig) {
  const ref = resolved.layers.identity;
  const tokens = ref?.adapter === 'static-identity' ? ref.options?.tokens : undefined;
  const token = process.env.AGENT_LAYERS_TOKEN || (tokens && typeof tokens === 'object' ? Object.keys(tokens)[0] : undefined);
  return token && stack.ports.identity ? { caller: await stack.verify(token) } : {};
}

test('smoke dataset passes offline with the scripted model', async () => {
  const resolved = await loadConfig(config, { profile: 'test' });
  const stack = await compose(resolved);
  try {
    const agent = await stack.agent('assistant');
    const ctx = await caller(stack, resolved);
    for (const c of cases) {
      const run = await agent.run(c.input, ctx);
      assert.equal(run.status, 'completed', `${c.id}: ${JSON.stringify(run.reason)}`);
      const scores = (await Promise.all(stack.ports.eval.map((e) => e.score(c, run)))).flat();
      assert.ok(scores.length > 0 && scores.every((s) => s.value === 1), `${c.id}: output "${run.output}"`);
    }
  } finally {
    await stack.close();
  }
});

test('the agent answers through the local model', { timeout: 180_000 }, async (t) => {
  const base = (process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, '');
  const model = process.env.LLM_MODEL ?? 'qwen3:4b';
  try {
    const res = await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) });
    const ids = ((await res.json()) as { data?: { id: string }[] }).data?.map((m) => m.id) ?? [];
    if (!ids.includes(model)) return t.skip(`model ${model} is not served at ${base}`);
  } catch {
    return t.skip(`no model server at ${base}`);
  }
  const resolved = await loadConfig(config, { profile: 'local' });
  const stack = await compose(resolved);
  try {
    const run = await (await stack.agent('assistant')).run('Convert 100 C to Fahrenheit', await caller(stack, resolved));
    assert.equal(run.status, 'completed', JSON.stringify(run.reason));
    assert.ok(run.output.length > 0);
  } finally {
    await stack.close();
  }
});
