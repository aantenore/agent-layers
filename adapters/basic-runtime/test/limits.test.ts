import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry } from '@agent-layers/core';
import { adapter, createBasicRuntime } from '../src/index.ts';
import { fakeStack, spec } from './helpers.ts';

const ctx = { name: 'runtime', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };

test('maxTurns takes effect when set', async () => {
  let calls = 0;
  const model = {
    chat: async () => {
      calls++;
      return { model: 'm', finish: 'tools', message: { role: 'assistant', parts: [{ type: 'call', id: `c${calls}`, tool: 't', args: {} }] } };
    },
  };
  const agent = await createBasicRuntime({ maxTurns: 3 }).bind(fakeStack({ model }), spec);
  const run = await agent.run('go');
  assert.deepEqual(run.reason, { code: 'limit', layer: 'harness', detail: 'turns' });
  assert.equal(run.status, 'stopped');
  assert.equal(calls, 3);
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  await registry.create('RuntimePort', 'basic-runtime', { maxTurns: '5' }, ctx);
  await assert.rejects(registry.create('RuntimePort', 'basic-runtime', { maxTurns: 0 }, ctx), /maxTurns/);
  await assert.rejects(registry.create('RuntimePort', 'basic-runtime', { maxTurns: 101 }, ctx), /maxTurns/);
  await assert.rejects(registry.create('RuntimePort', 'basic-runtime', { maxTurns: 'unbounded' }, ctx), /maxTurns/);
});
