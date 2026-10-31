import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, resolveProfile, type StackConfig } from '@agent-layers/core';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter as functions, defineTool } from '@agent-layers/adapter-functions';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { adapter } from '../src/index.ts';

const config: StackConfig = {
  layers: {
    model: { adapter: 'mock-model', options: { rules: [{ match: 'add (\\d+) and (\\d+)', tool: 'add', args: { a: '{{1}}', b: '{{2}}' } }] } },
    runtime: { adapter: 'basic-runtime', options: { maxTurns: 4 } },
    tools: { math: { adapter: 'functions' } },
  },
  agents: { calc: { instructions: 'You add numbers.', model: 'mock', tools: ['math__*'] } },
};

const add = defineTool({
  name: 'add', description: 'Adds two numbers', risk: 'read',
  inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] },
  run: async ({ a, b }) => `sum=${Number(a) + Number(b)}`,
});

async function stack() {
  const functionsWithAdd = { ...functions, create: () => functions.create({ tools: [add] }, { name: 'math', env: {}, cwd: process.cwd(), telemetry: undefined as never }) };
  return compose(resolveProfile(config), { adapters: [mockModel, adapter, functionsWithAdd] });
}

test('runs model → tool → final answer', async () => {
  const s = await stack();
  const agent = await s.agent('calc');
  const result = await agent.run('please add 2 and 3');
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'sum=5');
  assert.deepEqual(result.events?.map((e) => e.type), ['run_start', 'model_response', 'tool_call', 'tool_result', 'model_response', 'text', 'run_end']);
  await s.close();
});

test('stream yields the same events and ends with run_end', async () => {
  const s = await stack();
  const agent = await s.agent('calc');
  const types: string[] = [];
  for await (const e of agent.stream!('hello')) types.push(e.type);
  assert.deepEqual(types, ['run_start', 'model_response', 'text', 'run_end']);
  await s.close();
});

test('turn limit stops the run', async () => {
  const s = await compose(resolveProfile({ ...config, layers: { ...config.layers, runtime: { adapter: 'basic-runtime', options: { maxTurns: 1 } } } }), {
    adapters: [mockModel, adapter, { ...functions, create: () => functions.create({ tools: [add] }, { name: 'math', env: {}, cwd: process.cwd(), telemetry: undefined as never }) }],
  });
  const result = await (await s.agent('calc')).run('add 1 and 1');
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'max_turns');
  await s.close();
});

test('basic-runtime passes RuntimePort conformance', async () => {
  const s = await stack();
  const spec = { name: 'calc', instructions: '', model: 'mock', tools: ['math__*'] };
  const report = await checkAdapter(adapter, { options: {}, fixtures: { stack: s, agent: spec, input: 'add 4 and 5' } });
  assert.deepEqual(report.failures, []);
  await s.close();
});
