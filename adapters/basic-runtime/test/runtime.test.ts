import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter, conformance } from '@agent-layers/conformance';
import { adapter, createBasicRuntime } from '../src/index.ts';
import { fakeStack, reply, spec, stack } from './helpers.ts';

test('runs model → tool → final answer with core events', async () => {
  const { s } = await stack();
  const result = await (await s.agent('calc')).run('please add 2 and 3');
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'sum=5');
  assert.equal(result.reason, undefined);
  assert.deepEqual(result.events?.map((e) => e.type), ['run.start', 'model.reply', 'tool.call', 'tool.result', 'model.reply', 'text', 'run.end']);
  const [start, first, call, res, second, , end] = result.events!;
  assert.deepEqual([start?.type, (start as { agent: string }).agent], ['run.start', 'calc']);
  assert.deepEqual({ ...first }, { type: 'model.reply', turn: 1, model: 'mock', finish: 'tools', calls: 1 });
  assert.deepEqual({ ...call }, { type: 'tool.call', id: (call as { id: string }).id, tool: 'math__add' });
  assert.equal((res as { ok: boolean }).ok, true);
  assert.equal(typeof (res as { durationMs: number }).durationMs, 'number');
  assert.deepEqual({ ...second }, { type: 'model.reply', turn: 2, model: 'mock', finish: 'end', calls: 0 });
  assert.deepEqual({ ...end }, { type: 'run.end', status: 'completed', usage: result.usage });
  assert.ok(result.usage && result.usage.inputTokens > 0 && result.usage.outputTokens > 0);
  await s.close();
});

test('stream yields the same core events and ends with run.end', async () => {
  const { s } = await stack();
  const types: string[] = [];
  let last: unknown;
  for await (const e of (await s.agent('calc')).stream!('hello')) { types.push(e.type); last = e; }
  assert.deepEqual(types, ['run.start', 'model.reply', 'text', 'run.end']);
  assert.equal((last as { status: string }).status, 'completed');
  await s.close();
});

test('turn limit stops the run with a limit reason', async () => {
  const { s } = await stack({ maxTurns: 1 });
  const result = await (await s.agent('calc')).run('add 1 and 1');
  assert.equal(result.status, 'stopped');
  assert.deepEqual(result.reason, { code: 'limit', layer: 'harness', detail: 'turns' });
  assert.deepEqual(result.events?.at(-1), { type: 'run.end', status: 'stopped', reason: result.reason, usage: result.usage });
  await s.close();
});

test('a guard block stops the run with the guard stop reason and no internal text', async () => {
  const { s } = await stack({}, { layers: { guardrails: [{ adapter: 'test-guard' }] } });
  const result = await (await s.agent('calc')).run('this is forbidden');
  assert.equal(result.status, 'stopped');
  assert.deepEqual(result.reason, { code: 'guard_block', layer: 'guardrail', by: s.ports.guardrails[0]!.name, stage: 'input' });
  assert.equal(result.output, '');
  assert.ok(!JSON.stringify(result).includes('secret internal text'));
  await s.close();
});

test('a call waiting for approval ends the run waiting', async () => {
  const { s } = await stack({}, { layers: { approval: { adapter: 'test-approval' } }, policy: [{ effect: 'ask', tools: ['math__save'] }] });
  const agent = await s.agent('calc');
  const result = await agent.run('save note');
  assert.equal(result.status, 'waiting');
  assert.deepEqual(result.reason, { code: 'needs_input', layer: 'identity', by: s.ports.approval!.name, detail: 'ap-1' });
  assert.equal(result.output, '');
  assert.deepEqual(result.events?.map((e) => e.type), ['run.start', 'model.reply', 'tool.call', 'tool.result', 'run.end']);
  assert.equal((result.events?.[3] as { ok: boolean }).ok, false);
  assert.deepEqual(result.events?.at(-1), { type: 'run.end', status: 'waiting', reason: result.reason, usage: result.usage });
  // The streamed run ends the same way.
  const streamed = [];
  for await (const e of agent.stream!('save note')) streamed.push(e);
  assert.deepEqual(streamed.at(-1), { type: 'run.end', status: 'waiting', reason: result.reason, usage: result.usage });
  await s.close();
});

test('a denied call is an error result and the run goes on', async () => {
  const { s } = await stack({}, { policy: [{ effect: 'deny', tools: ['math__save'] }] });
  const result = await (await s.agent('calc')).run('save note');
  assert.equal(result.status, 'completed');
  assert.equal((result.events?.find((e) => e.type === 'tool.result') as { ok: boolean }).ok, false);
  assert.match(result.output, /Denied: denied by policy/);
  await s.close();
});

test('an aborted run is stopped with reason aborted; a timeout is reported as such', async () => {
  const { s } = await stack();
  const agent = await s.agent('calc');
  const aborted = await agent.run('add 1 and 2', { signal: AbortSignal.abort() });
  assert.equal(aborted.status, 'stopped');
  assert.deepEqual(aborted.reason, { code: 'aborted' });
  const expired = AbortSignal.timeout(1);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual((await agent.run('add 1 and 2', { signal: expired })).reason, { code: 'timeout' });
  await s.close();
});

test('a model error fails the run with a reason that carries no error text', async () => {
  const model = { chat: async () => { throw new TypeError('boom with sk-secret'); } };
  const agent = await createBasicRuntime().bind(fakeStack({ model }), spec);
  const result = await agent.run('x');
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.reason, { code: 'error', detail: 'TypeError' });
  assert.ok(!JSON.stringify(result).includes('sk-secret'));
});

test('costUsd is reported when every model call is priced, and absent otherwise', async () => {
  const priced = await stack({ pricing: { mock: { inputPerMTok: 3, outputPerMTok: 15 } } });
  const r = await (await priced.s.agent('calc')).run('please add 2 and 3');
  const expected = (r.usage!.inputTokens * 3 + r.usage!.outputTokens * 15) / 1e6;
  assert.ok(Math.abs((r.costUsd ?? -1) - expected) < 1e-12, `${r.costUsd} vs ${expected}`);
  assert.equal((r.events?.at(-1) as { costUsd?: number }).costUsd, r.costUsd);
  await priced.s.close();
  const plain = await stack();
  assert.equal((await (await plain.s.agent('calc')).run('please add 2 and 3')).costUsd, undefined);
  await plain.s.close();
});

test('settings and model-namespaced ext of the agent reach the model request', async () => {
  const seen: unknown[] = [];
  const model = { chat: async (req: unknown) => { seen.push(structuredClone(req)); return reply('ok'); } };
  const agent = await createBasicRuntime().bind(fakeStack({ model }), {
    ...spec, instructions: 'be brief', settings: { temperature: 0, maxOutputTokens: 50 }, ext: { 'openai.seed': 7 },
  });
  assert.equal((await agent.run('hi')).status, 'completed');
  assert.deepEqual(seen[0], {
    model: 'm', settings: { temperature: 0, maxOutputTokens: 50 }, ext: { 'openai.seed': 7 },
    messages: [{ role: 'system', parts: [{ type: 'text', text: 'be brief' }] }, { role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
  });
});

test('a call with unparsed arguments is answered with a tool error', async () => {
  const replies = [
    { model: 'm', finish: 'tools', message: { role: 'assistant', parts: [{ type: 'call', id: 'c1', tool: 't', args: {}, invalid: '{oops' }] } },
    reply('done'),
  ];
  const called: string[] = [];
  const tools = { listTools: async () => [], callTool: async (name: string) => { called.push(name); return { ok: true, text: 'x' }; } };
  const agent = await createBasicRuntime().bind(fakeStack({ model: { chat: async () => replies.shift() }, tools }), { ...spec, tools: ['t'] });
  const result = await agent.run('go');
  assert.equal(result.output, 'done');
  assert.deepEqual(called, []);
  assert.equal((result.events?.find((e) => e.type === 'tool.result') as { ok: boolean }).ok, false);
});

test('basic-runtime passes RuntimePort conformance and checkAdapter', async () => {
  const { s } = await stack();
  const spec = { name: 'calc', instructions: '', model: 'mock', tools: ['math__*'] };
  const report = await checkAdapter(adapter, { options: {}, fixtures: { stack: s, agent: spec, input: 'add 4 and 5' } });
  assert.deepEqual(report.failures, []);
  assert.equal(report.ok, true);
  await s.close();
});

test('conformance holds for a run that waits for a person', async () => {
  const { s } = await stack({}, { layers: { approval: { adapter: 'test-approval' } }, policy: [{ effect: 'ask', tools: ['math__save'] }] });
  const report = await conformance('RuntimePort', createBasicRuntime(), { stack: s, agent: { name: 'calc', instructions: '', model: 'mock', tools: ['math__*'] }, input: 'save note' });
  assert.deepEqual(report.failures, []);
  await s.close();
});
