import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry, type ModelPort, type ModelReply } from '@agent-layers/core';
import { adapter, createJudgeEval, parseJudgement } from '../src/index.ts';

const ctx = { name: 'judge', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const reply = (content: string): ModelReply => ({ model: 'judge-x', message: { role: 'assistant', parts: [{ type: 'text', text: content }] }, finish: 'end' });
const model: ModelPort = { name: 'stub', chat: async () => reply(`{"score":1,"reason":"${'r'.repeat(50)}"}`) };

test('maxReasonChars truncates the reason', async () => {
  assert.equal(parseJudgement(`{"score":1,"reason":"${'x'.repeat(50)}"}`, 10)!.reason, `${'x'.repeat(9)}…`);
  const [score] = await createJudgeEval({ model: 'j', maxReasonChars: 20 }, { model }).score({ id: 'c', input: 'q' }, { runId: 'r', output: 'a', status: 'completed' });
  assert.equal(score!.reason!.length, 20);
});

test('maxTokens reaches the model request', async () => {
  const seen: (number | undefined)[] = [];
  const spy: ModelPort = { name: 'spy', chat: async (req) => { seen.push(req.settings?.maxOutputTokens); return reply('{"score":1,"reason":"ok"}'); } };
  await createJudgeEval({ model: 'j', maxTokens: 64 }, { model: spy }).score({ id: 'c', input: 'q' }, { runId: 'r', output: 'a', status: 'completed' });
  assert.deepEqual(seen, [64]);
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  const backend = { adapter: 'x' };
  // Validation runs before create; a valid value reaches create, which then reports the missing stack or adapter.
  await assert.rejects(registry.create('EvaluatorPort', 'judge-eval', { model: 'j', backend, maxTokens: '128', maxReasonChars: '100' }, ctx), (err: Error) => !/maxTokens|maxReasonChars/.test(err.message));
  for (const bad of [{ maxTokens: 0 }, { maxTokens: 'unbounded' }, { maxReasonChars: 0 }, { maxReasonChars: 'unbounded' }]) {
    await assert.rejects(registry.create('EvaluatorPort', 'judge-eval', { model: 'j', backend, ...bad }, ctx), new RegExp(Object.keys(bad)[0]!), JSON.stringify(bad));
  }
});

test('ext in the options must have namespaced keys', async () => {
  const registry = new AdapterRegistry().register(adapter);
  await assert.rejects(registry.create('EvaluatorPort', 'judge-eval', { model: 'j', backend: { adapter: 'x' }, ext: { seed: 1 } }, ctx), /ext/);
  await assert.rejects(registry.create('EvaluatorPort', 'judge-eval', { model: 'j', backend: { adapter: 'x' }, extra: { seed: 1 } }, ctx), /extra/);
});
