import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter, conformance } from '@agent-layers/conformance';
import { createReinloopRuntime, adapter } from '../src/index.ts';
import { scriptedModel, seen, stack, textReply } from './helpers.ts';

const types = (events: { type: string }[] | undefined) => events?.map((e) => e.type);
const rec = (events: unknown) => (events ?? []) as Record<string, unknown>[];

test('runs model → governed tool → final answer through the stack with core events', async () => {
  const { s, records, spans } = await stack();
  const result = await (await s.agent('calc')).run('please add 2 and 3', { caller: { id: 'ada', kind: 'user', roles: [], scopes: [], credential: 'secret' } });
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'sum=5');
  assert.equal(result.reason, undefined);
  assert.deepEqual(types(result.events), ['run.start', 'model.reply', 'reinloop.usage', 'tool.call', 'tool.result', 'model.reply', 'reinloop.usage', 'run.end']);
  const ev = rec(result.events);
  assert.deepEqual({ ...ev[1] }, { type: 'model.reply', turn: 1, model: 'mock', finish: 'tools', calls: 1 });
  assert.deepEqual({ ...ev[5] }, { type: 'model.reply', turn: 2, model: 'mock', finish: 'end', calls: 0 });
  assert.deepEqual([ev[3]!.tool, ev[3]!.id], ['math__add', ev[4]!.id]);
  assert.equal(ev[4]!.ok, true);
  assert.equal(typeof ev[4]!.durationMs, 'number');
  assert.equal(ev[2]!.turn, 1);
  assert.deepEqual(ev[2]!.usage, { inputTokens: (ev[2]!.usage as { inputTokens: number }).inputTokens, outputTokens: (ev[2]!.usage as { outputTokens: number }).outputTokens });
  assert.deepEqual({ ...ev[7], costUsd: undefined }, { type: 'run.end', status: 'completed', usage: result.usage, costUsd: undefined });
  assert.ok(result.usage && result.usage.inputTokens > 0 && result.usage.outputTokens > 0);
  assert.deepEqual(seen.at(-1), { caller: 'ada', signal: true }, 'the call context reaches the tool');
  // One span per model call and per tool call, all from the pipeline; the adapter adds none of its own.
  assert.equal(spans('agent.model.call').length, 2);
  assert.equal(spans('agent.tool.call').length, 1);
  assert.equal(spans('agent.run').length, 1);
  assert.ok(!records.some((r) => r.name === 'chat' || r.name === 'execute_tool'));
  assert.ok(!JSON.stringify(records).includes('gen_ai.'), 'no standard-owned names');
  assert.ok(!JSON.stringify(result.events).includes('secret'), 'no credential in events');
  await s.close();
});

test('stream yields text deltas and ends with run.end', async () => {
  const { s } = await stack();
  const events: Record<string, unknown>[] = [];
  for await (const e of (await s.agent('calc')).stream!('hello there')) events.push(e as Record<string, unknown>);
  assert.equal(events[0]?.type, 'run.start');
  const end = events.at(-1)!;
  assert.equal(end.type, 'run.end');
  assert.equal(end.status, 'completed');
  assert.ok(events.every((e) => !('output' in e)), 'the output is in the text events, not in run.end');
  assert.match(events.filter((e) => e.type === 'text').map((e) => String(e.text)).join(''), /hello there/);
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
  assert.equal(rec(r.events).find((e) => e.type === 'tool.result')?.ok, false);
  assert.match(r.output, /Denied: denied by policy/);
  assert.equal(denied.spans('agent.access.check').length, 1);
  await denied.s.close();
});

test('a guard block stops the run with the guard stop reason', async () => {
  const { s } = await stack({}, { layers: { guardrails: [{ adapter: 'test-guard' }] } });
  const r = await (await s.agent('calc')).run('this is forbidden');
  assert.equal(r.status, 'stopped');
  assert.deepEqual(r.reason, { code: 'guard_block', layer: 'guardrail', by: s.ports.guardrails[0]!.name, stage: 'input' });
  assert.equal(r.output, '');
  assert.ok(!JSON.stringify(r).includes('secret internal text'));
  assert.deepEqual(r.events?.at(-1), { type: 'run.end', status: 'stopped', reason: r.reason, usage: r.usage, costUsd: 0 });
  await s.close();
});

test('a call waiting for approval ends the run waiting', async () => {
  const { s } = await stack({}, { layers: { approval: { adapter: 'test-approval' } }, policy: [{ effect: 'ask', tools: ['math__save'] }] });
  const agent = await s.agent('calc');
  const r = await agent.run('save note');
  assert.equal(r.status, 'waiting');
  assert.deepEqual(r.reason, { code: 'needs_input', layer: 'identity', by: s.ports.approval!.name, detail: 'ap-1' });
  assert.equal(r.output, '');
  assert.deepEqual(types(r.events)?.filter((t) => t !== 'reinloop.usage'), ['run.start', 'model.reply', 'tool.call', 'run.end']);
  assert.deepEqual(r.events?.at(-1), { type: 'run.end', status: 'waiting', reason: r.reason, usage: r.usage, costUsd: 0 });
  const streamed: unknown[] = [];
  for await (const e of agent.stream!('save note')) streamed.push(e);
  assert.deepEqual(streamed.at(-1), r.events?.at(-1));
  await s.close();
});

test('budgets stop the run with a limit reason and are reported to telemetry', async () => {
  const { s, records } = await stack({ budget: { maxTurns: 1 } });
  const r = await (await s.agent('calc')).run('add 1 and 1');
  assert.equal(r.status, 'stopped');
  assert.deepEqual(r.reason, { code: 'limit', layer: 'harness', by: 'reinloop', detail: 'maxTurns' });
  assert.ok(records.some((x) => x.type === 'event' && x.name === 'reinloop.budget.exceeded' && x.attrs['reinloop.limit'] === 'maxTurns' && x.layer === 'harness'));
  assert.ok(!records.some((x) => x.name.startsWith('agent.budget') || x.name === 'agent.compaction'));
  await s.close();
});

test('compaction runs from the threshold, is mapped to an event and recorded', async () => {
  const { s, records } = await stack({ compaction: { strategy: 'window', thresholdTokens: 1, keepLast: 2 } });
  const text = (role: 'user' | 'assistant', t: string) => ({ role, parts: [{ type: 'text' as const, text: t }] });
  const r = await (await s.agent('calc')).run({
    messages: [text('user', 'first question'), text('assistant', 'first answer'), text('user', 'second question'), text('assistant', 'second answer'), text('user', 'add 2 and 2')],
  });
  assert.equal(r.status, 'completed');
  assert.equal(r.output, 'sum=4');
  const c = rec(r.events).find((e) => e.type === 'reinloop.compaction');
  assert.equal(c?.strategy, 'window');
  assert.ok(records.some((x) => x.type === 'event' && x.name === 'reinloop.compaction' && x.layer === 'harness' && x.attrs['reinloop.strategy'] === 'window'));
  await s.close();
});

test('pricing gives the run a cost, as a run.end field and a reinloop.cost.usd metric', async () => {
  const { s, records } = await stack({ pricing: { mock: { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000 } } });
  const r = await (await s.agent('calc')).run('add 2 and 3');
  const end = rec(r.events).find((e) => e.type === 'run.end');
  assert.ok(Number(end?.costUsd) > 0);
  assert.equal(r.costUsd, end?.costUsd, 'the result carries the cost too');
  assert.ok(records.some((x) => x.type === 'metric' && x.name === 'reinloop.cost.usd' && x.value === end?.costUsd));
  const perTurn = rec(r.events).filter((e) => e.type === 'reinloop.usage').reduce((sum, e) => sum + Number(e.costUsd), 0);
  assert.ok(Math.abs(perTurn - Number(end?.costUsd)) < 1e-9);
  await s.close();
});

test('an aborted run is stopped with reason aborted, an expired signal with timeout', async () => {
  const { s } = await stack();
  const agent = await s.agent('calc');
  const aborted = await agent.run('add 1 and 2', { signal: AbortSignal.abort() });
  assert.equal(aborted.status, 'stopped');
  assert.deepEqual(aborted.reason, { code: 'aborted' });
  const expired = AbortSignal.timeout(1);
  await new Promise((r) => setTimeout(r, 10));
  const timedOut = await agent.run('add 1 and 2', { signal: expired });
  assert.equal(timedOut.status, 'stopped');
  assert.deepEqual(timedOut.reason, { code: 'timeout' });
  await s.close();
});

test('a model error fails the run with a reason that carries no error text', async () => {
  const script = scriptedModel([new TypeError('boom with sk-secret')]);
  const { s } = await stack({}, { layers: { model: { adapter: 'test-script' } } }, { adapters: [script.adapter] });
  const r = await (await s.agent('calc')).run('hello');
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.reason, { code: 'error', detail: 'TypeError' });
  assert.ok(!JSON.stringify(r).includes('sk-secret'));
  await s.close();
});

test('agent settings and model-namespaced ext reach the model; reinloop.retryMaxTokens repeats a cut answer', async () => {
  const script = scriptedModel([textReply('cut', 'limit'), textReply('whole answer')]);
  const { s } = await stack({}, { layers: { model: { adapter: 'test-script' } } }, {
    adapters: [script.adapter],
    agent: { settings: { temperature: 0.2, maxOutputTokens: 10, stop: ['END'] }, ext: { 'openai.seed': 7, 'reinloop.retryMaxTokens': 99 } },
  });
  const r = await (await s.agent('calc')).run('hello');
  assert.equal(r.status, 'completed');
  assert.equal(r.output, 'whole answer');
  assert.deepEqual(script.requests[0]?.settings, { temperature: 0.2, maxOutputTokens: 10, stop: ['END'] });
  assert.deepEqual(script.requests[0]?.ext, { 'openai.seed': 7 });
  assert.equal(script.requests[1]?.settings?.maxOutputTokens, 99);
  assert.equal(script.requests[0]?.messages[0]?.role, 'system');
  await s.close();
});

test('an answer cut at the token limit completes and says so; an empty cut answer stops', async () => {
  const cut = scriptedModel([textReply('cut', 'limit')]);
  const a = await stack({}, { layers: { model: { adapter: 'test-script' } } }, { adapters: [cut.adapter] });
  const r = await (await a.s.agent('calc')).run('hello');
  assert.equal(r.status, 'completed');
  assert.equal(r.output, 'cut');
  assert.deepEqual(r.reason, { code: 'limit', layer: 'harness', by: 'reinloop', detail: 'max_tokens' });
  await a.s.close();
  const empty = scriptedModel([{ ...textReply('', 'limit'), message: { role: 'assistant', parts: [] } }]);
  const b = await stack({}, { layers: { model: { adapter: 'test-script' } } }, { adapters: [empty.adapter] });
  const e = await (await b.s.agent('calc')).run('hello');
  assert.equal(e.status, 'stopped');
  assert.deepEqual(e.reason, { code: 'limit', layer: 'harness', by: 'reinloop', detail: 'max_tokens' });
  await b.s.close();
});

test('reinloop passes RuntimePort conformance and checkAdapter', async () => {
  const { s } = await stack();
  const spec = { name: 'calc', instructions: '', model: 'mock', tools: ['math__*'] };
  const report = await checkAdapter(adapter, { options: { budget: { maxTurns: 4 } }, fixtures: { stack: s, agent: spec, input: 'add 4 and 5' } });
  assert.deepEqual(report.failures, []);
  assert.equal(report.ok, true);
  await s.close();
});

test('conformance holds for runs that wait, are blocked or hit a budget', async () => {
  const waiting = await stack({}, { layers: { approval: { adapter: 'test-approval' } }, policy: [{ effect: 'ask', tools: ['math__save'] }] });
  const spec = { name: 'calc', instructions: '', model: 'mock', tools: ['math__*'] };
  const run = (st: typeof waiting, input: string, options = {}) => conformance('RuntimePort', createReinloopRuntime(options), { stack: st.s, agent: spec, input });
  assert.deepEqual((await run(waiting, 'save note')).failures, []);
  await waiting.s.close();
  const blocked = await stack({}, { layers: { guardrails: [{ adapter: 'test-guard' }] } });
  assert.deepEqual((await run(blocked, 'forbidden')).failures, []);
  await blocked.s.close();
  const limited = await stack();
  assert.deepEqual((await run(limited, 'add 1 and 1', { budget: { maxTurns: 1 } })).failures, []);
  await limited.s.close();
});
