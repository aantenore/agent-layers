import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, compose, noMappings, noopTelemetry, resolveProfile, type CallContext, type StackConfig } from '@agent-layers/core';
import { adapter as functions, defineTool } from '@agent-layers/adapter-functions';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { adapter, type ReinloopOptions } from '../src/index.ts';

const actx = { name: 'runtime', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const add = defineTool({
  name: 'add', description: 'Adds two numbers', risk: 'read',
  params: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] },
  run: async ({ a, b }, _ctx: CallContext) => `sum=${Number(a) + Number(b)}`,
});

async function run(runtime: ReinloopOptions, input = 'add 2 and 3') {
  const config: StackConfig = {
    layers: {
      model: { adapter: 'mock-model', options: { rules: [{ match: 'add (\\d+) and (\\d+)', tool: 'add', args: { a: '{{1}}', b: '{{2}}' } }] } },
      runtime: { adapter: 'reinloop', options: runtime as Record<string, unknown> },
      tools: { math: { adapter: 'functions' } },
    },
    agents: { calc: { instructions: '', model: 'mock', tools: ['math__*'] } },
  };
  const math = { ...functions, create: () => functions.create({ tools: [add] }, { name: 'math', env: {}, cwd: process.cwd(), telemetry: undefined as never, mappings: noMappings() }) };
  const s = await compose(resolveProfile(config), { adapters: [mockModel, adapter, math] });
  try { return await (await s.agent('calc')).run(input); } finally { await s.close(); }
}

test('the defaults let a run complete; unbounded settings are left to reinloop as absent', async () => {
  assert.equal((await run({})).output, 'sum=5');
  const open = await run({ budget: { maxTurns: 'unbounded', maxCostUsd: 'unbounded' }, tools: { timeoutMs: 'unbounded', concurrency: 2 } });
  assert.equal(open.status, 'completed');
  assert.equal(open.output, 'sum=5');
});

test('budget and tool limits take effect when set', async () => {
  const calls = await run({ budget: { maxToolCalls: 1 } });
  assert.equal(calls.status, 'stopped');
  assert.deepEqual(calls.reason, { code: 'limit', layer: 'harness', by: 'reinloop', detail: 'maxToolCalls' });
  const turns = await run({ budget: { maxTotalTokens: 1 } });
  assert.deepEqual(turns.reason, { code: 'limit', layer: 'harness', by: 'reinloop', detail: 'maxTotalTokens' });
  const cut = await run({ tools: { maxResultChars: 2 } });
  assert.match(cut.output, /output truncated: 5 chars total/);
  const timed = await run({ tools: { timeoutMs: 5000 } });
  assert.equal(timed.output, 'sum=5');
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  const make = (options: Record<string, unknown>) => registry.create('RuntimePort', 'reinloop', options, actx);
  await make({
    budget: { maxTurns: '5', maxToolCalls: '20', maxInputTokens: '1000', maxOutputTokens: '1000', maxTotalTokens: '2000', maxCostUsd: '0.5', maxDurationMs: '60000' },
    compaction: { thresholdTokens: '8000', keepFirst: '1', keepLast: '10', maxTokens: '500' },
    tools: { concurrency: '4', timeoutMs: '2000', maxResultChars: '4000' },
  });
  await make({ budget: { maxTurns: 'unbounded', maxToolCalls: 'unbounded', maxCostUsd: 'unbounded', maxDurationMs: 'unbounded' }, tools: { timeoutMs: 'unbounded', maxResultChars: 'unbounded' } });
  await assert.rejects(make({ budget: { maxTurns: 0 } }), /maxTurns/);
  await assert.rejects(make({ budget: { maxCostUsd: -1 } }), /maxCostUsd/);
  await assert.rejects(make({ budget: { maxDurationMs: '0' } }), /maxDurationMs/);
  await assert.rejects(make({ compaction: { thresholdTokens: 'unbounded' } }), /thresholdTokens/);
  await assert.rejects(make({ compaction: { thresholdTokens: 1, keepFirst: -1 } }), /keepFirst/);
  await assert.rejects(make({ compaction: { thresholdTokens: 1, maxTokens: 'unbounded' } }), /maxTokens/);
  await assert.rejects(make({ tools: { concurrency: 'unbounded' } }), /concurrency/);
  await assert.rejects(make({ tools: { concurrency: 0 } }), /concurrency/);
  await assert.rejects(make({ tools: { timeoutMs: 0 } }), /timeoutMs/);
});
