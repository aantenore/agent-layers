import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, compose, defineAdapter, noMappings, noopTelemetry, PORT_VERSIONS, resolveProfile, type CallContext, type ModelPort, type StackConfig } from '@agent-layers/core';
import { adapter as functions, defineTool } from '@agent-layers/adapters/functions';
import { adapter as mockModel } from '@agent-layers/adapters/mock-model';
import { adapter, type ReinloopOptions } from '../../src/reinloop/index.ts';
import { callReply, stack, textReply } from './helpers.ts';

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

test('the defaults let a run complete; unbounded settings lift the limits', async () => {
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

/** Model that calls a tool on every turn, and answers only after `answerAfter` turns. */
function loopingModel(answerAfter = Infinity) {
  let turns = 0;
  const model = defineAdapter<'ModelPort'>({
    layer: 'llm', port: 'ModelPort', name: 'test-loop', direction: 'outbound', maps: { technology: 'test' },
    portVersion: PORT_VERSIONS.ModelPort, tiers: ['prototype'],
    create: (_o, ctx): ModelPort => ({
      name: ctx.name,
      chat: async () => (++turns > answerAfter ? textReply('done') : callReply([{ type: 'call', id: `c${turns}`, tool: 'math__add', args: { a: '1', b: '2' } }])),
    }),
  });
  return { model, turns: () => turns };
}

async function loop(runtime: ReinloopOptions, answerAfter?: number) {
  const { model, turns } = loopingModel(answerAfter);
  const { s } = await stack(runtime, { layers: { model: { adapter: 'test-loop' } } }, { adapters: [model] });
  try { return { result: await (await s.agent('calc')).run('loop'), turns: turns() }; } finally { await s.close(); }
}

test('a budget without maxTurns keeps the turn limit of 50; an unbounded maxTurns lifts it', async () => {
  const capped = await loop({ budget: { maxCostUsd: 0.5 } });
  assert.equal(capped.result.status, 'stopped');
  assert.deepEqual(capped.result.reason, { code: 'limit', layer: 'harness', by: 'reinloop', detail: 'maxTurns' });
  assert.equal(capped.turns, 50);
  const open = await loop({ budget: { maxTurns: 'unbounded', maxCostUsd: 0.5 } }, 60);
  assert.equal(open.result.status, 'completed');
  assert.equal(open.turns, 61);
});
