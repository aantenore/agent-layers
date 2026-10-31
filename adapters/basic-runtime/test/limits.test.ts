import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry } from '@agent-layers/core';
import { adapter, createBasicRuntime } from '../src/index.ts';

const ctx = { name: 'runtime', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };

test('maxTurns takes effect when set', async () => {
  let calls = 0;
  const stack = {
    context: (init: object) => ({ runId: 'r', ...init }),
    modelFor: () => ({ chat: async () => { calls++; return { id: 'x', model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `c${calls}`, type: 'function', function: { name: 't', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }; } }),
    toolsFor: () => ({ listTools: async () => [], callTool: async () => ({ content: 'ok' }) }),
  };
  const agent = await createBasicRuntime({ maxTurns: 3 }).bind(stack as never, { name: 'a', instructions: '', model: 'm', tools: [] } as never);
  const run = await agent.run('go');
  assert.equal(run.reason, 'max_turns');
  assert.equal(calls, 3);
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  await registry.create('RuntimePort', 'basic-runtime', { maxTurns: '5' }, ctx);
  await assert.rejects(registry.create('RuntimePort', 'basic-runtime', { maxTurns: 0 }, ctx), /maxTurns/);
  await assert.rejects(registry.create('RuntimePort', 'basic-runtime', { maxTurns: 101 }, ctx), /maxTurns/);
  await assert.rejects(registry.create('RuntimePort', 'basic-runtime', { maxTurns: 'unbounded' }, ctx), /maxTurns/);
});
