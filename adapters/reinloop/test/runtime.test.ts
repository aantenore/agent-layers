import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, recordingTelemetry, resolveProfile, type CallContext, type StackConfig, type TelemetryRecord } from '@agent-layers/core';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter as functions, defineTool } from '@agent-layers/adapter-functions';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { adapter as regexGuard } from '@agent-layers/adapter-regex-guard';
import { adapter, type ReinloopOptions } from '../src/index.ts';

const seen: { subject?: string; signal?: boolean }[] = [];

const add = defineTool({
  name: 'add', description: 'Adds two numbers', risk: 'read',
  inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] },
  run: async ({ a, b }, ctx: CallContext) => {
    seen.push({ ...(ctx.identity ? { subject: ctx.identity.subject } : {}), signal: !!ctx.signal });
    return `sum=${Number(a) + Number(b)}`;
  },
});
const save = defineTool({
  name: 'save', description: 'Saves a note', risk: 'write',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  run: async ({ text }) => `saved ${String(text)}`,
});

const rules = [
  { match: 'add (\\d+) and (\\d+)', tool: 'add', args: { a: '{{1}}', b: '{{2}}' } },
  { match: 'save (\\w+)', tool: 'save', args: { text: '{{1}}' } },
];

function config(runtime: ReinloopOptions = {}, extra: Partial<StackConfig> = {}): StackConfig {
  return {
    layers: {
      model: { adapter: 'mock-model', options: { rules } },
      runtime: { adapter: 'reinloop', options: runtime as Record<string, unknown> },
      tools: { math: { adapter: 'functions' } },
      ...extra.layers,
    },
    agents: { calc: { instructions: 'You add numbers.', model: 'mock', tools: ['math__*'] } },
    ...(extra.policy ? { policy: extra.policy } : {}),
  };
}

async function stack(runtime: ReinloopOptions = {}, extra: Partial<StackConfig> = {}) {
  const records: TelemetryRecord[] = [];
  const math = { ...functions, create: () => functions.create({ tools: [add, save] }, { name: 'math', env: {}, cwd: process.cwd(), telemetry: undefined as never }) };
  const s = await compose(resolveProfile(config(runtime, extra)), { adapters: [mockModel, adapter, math, regexGuard], telemetry: [recordingTelemetry((r) => records.push(r))] });
  return { s, records, spans: (name: string) => records.filter((r) => r.type === 'span' && r.name === name) };
}

test('runs model → governed tool → final answer through the stack', async () => {
  const { s, spans } = await stack();
  const result = await (await s.agent('calc')).run('please add 2 and 3', { identity: { subject: 'ada', kind: 'user', token: 'secret' } });
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'sum=5');
  assert.deepEqual(result.events?.map((e) => e.type), ['run_start', 'model_response', 'tool_call', 'tool_result', 'model_response', 'run_end']);
  assert.ok(result.usage && result.usage.prompt_tokens > 0 && result.usage.total_tokens === result.usage.prompt_tokens + result.usage.completion_tokens);
  assert.deepEqual(seen.at(-1), { subject: 'ada', signal: true }, 'the call context reaches the tool');
  // One span per model call and per tool call, all from the pipeline; the adapter adds none of its own.
  assert.equal(spans('chat').length, 2);
  assert.equal(spans('execute_tool').length, 1);
  assert.equal(spans('invoke_agent').length, 1);
  assert.ok(!JSON.stringify(result.events).includes('secret'), 'no token in events');
  await s.close();
});

test('stream yields text deltas and ends with run_end carrying the output', async () => {
  const { s } = await stack();
  const events = [];
  for await (const e of (await s.agent('calc')).stream!('hello there')) events.push(e);
  assert.equal(events[0]?.type, 'run_start');
  const end = events.at(-1)!;
  assert.equal(end.type, 'run_end');
  assert.equal(end.status, 'completed');
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), end.output);
  assert.match(String(end.output), /hello there/);
  await s.close();
});

test('the SDK policy decides: reinloop does not ask for write tools, a deny rule denies', async () => {
  const allowed = await stack();
  const ok = await (await allowed.s.agent('calc')).run('save note');
  assert.equal(ok.status, 'completed');
  assert.equal(ok.output, 'saved note');
  await allowed.s.close();

  const denied = await stack({}, { policy: [{ effect: 'deny', tools: ['math__save'] }] });
  const r = await (await denied.s.agent('calc')).run('save note');
  assert.equal(r.events?.find((e) => e.type === 'tool_result')?.isError, true);
  assert.match(r.output, /Denied: denied by policy/);
  assert.equal(denied.spans('authorize').length, 1);
  await denied.s.close();
});

test('a guardrail block stops the run with the guardrail reason', async () => {
  const { s } = await stack({}, { layers: { guardrails: [{ adapter: 'regex-guard', options: { piiAction: 'block', stages: ['input'] } }] } });
  const r = await (await s.agent('calc')).run('mail me at ada@example.com');
  assert.equal(r.status, 'stopped');
  assert.equal(r.reason, 'guardrail:regex-guard:input');
  assert.equal(r.output, '');
  await s.close();
});

test('budgets stop the run and are reported to telemetry', async () => {
  const { s, records } = await stack({ budget: { maxTurns: 1 } });
  const r = await (await s.agent('calc')).run('add 1 and 1');
  assert.equal(r.status, 'stopped');
  assert.equal(r.reason, 'budget:maxTurns');
  assert.ok(records.some((x) => x.type === 'event' && x.name === 'agent.budget.exceeded' && x.attrs['budget.limit'] === 'maxTurns'));
  await s.close();
});

test('compaction runs from the threshold and is recorded', async () => {
  const { s, records } = await stack({ compaction: { strategy: 'window', thresholdTokens: 1, keepLast: 2 } });
  const r = await (await s.agent('calc')).run({
    messages: [
      { role: 'user', content: 'first question' }, { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' }, { role: 'assistant', content: 'second answer' },
      { role: 'user', content: 'add 2 and 2' },
    ],
  });
  assert.equal(r.status, 'completed');
  assert.equal(r.output, 'sum=4');
  const c = r.events?.find((e) => e.type === 'compaction');
  assert.equal(c?.strategy, 'window');
  assert.ok(records.some((x) => x.type === 'event' && x.name === 'agent.compaction' && x.layer === 'harness'));
  await s.close();
});

test('pricing gives the run a cost, as a run_end field and an agent.cost.usd metric', async () => {
  const { s, records } = await stack({ pricing: { mock: { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000 } } });
  const r = await (await s.agent('calc')).run('add 2 and 3');
  const end = r.events?.find((e) => e.type === 'run_end');
  assert.ok(Number(end?.costUsd) > 0);
  assert.equal(r.costUsd, end?.costUsd, 'the result carries the cost too');
  assert.ok(records.some((x) => x.type === 'metric' && x.name === 'agent.cost.usd' && x.value === end?.costUsd));
  await s.close();
});

test('an aborted run is stopped with reason aborted', async () => {
  const { s } = await stack();
  const r = await (await s.agent('calc')).run('add 1 and 2', { signal: AbortSignal.abort() });
  assert.equal(r.status, 'stopped');
  assert.equal(r.reason, 'aborted');
  await s.close();
});

test('reinloop passes RuntimePort conformance', async () => {
  const { s } = await stack();
  const spec = { name: 'calc', instructions: '', model: 'mock', tools: ['math__*'] };
  const report = await checkAdapter(adapter, { options: { budget: { maxTurns: 4 } }, fixtures: { stack: s, agent: spec, input: 'add 4 and 5' } });
  assert.deepEqual(report.failures, []);
  await s.close();
});
