import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testContext } from '@agent-layers/conformance';
import { assembleDeltas, callsOf, replyText, textMessage, type Message, type ModelDelta, type ModelRequest, type ToolInfo } from '@agent-layers/core';
import { createMockModel, type MockModelOptions } from '../src/index.ts';

const tool = (name: string): ToolInfo => ({ name, params: { type: 'object' } });
const ask = (text: string, extra: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'x', messages: [textMessage('user', text)], ...extra });
const chat = (options: MockModelOptions, req: ModelRequest) => createMockModel(options).chat(req, testContext());

test('echoes the last user message by default', async () => {
  const res = await chat({}, ask('hello there'));
  assert.equal(res.model, 'mock');
  assert.equal(replyText(res), 'You said: hello there');
  assert.equal(res.finish, 'end');
});

test('usage is derived from character counts', async () => {
  const res = await chat({}, ask('12345678'));
  // prompt 8 chars -> 2 tokens; "You said: 12345678" is 18 chars -> 5 tokens
  assert.deepEqual(res.usage, { inputTokens: 2, outputTokens: 5 });
});

test('a tool result becomes the final answer, trimmed and capped', async () => {
  const messages: Message[] = [
    textMessage('user', 'time?'),
    { role: 'assistant', parts: [{ type: 'call', id: 'call_1', tool: 'clock__now', args: {} }] },
    { role: 'tool', parts: [{ type: 'result', callId: 'call_1', ok: true, text: `  ${'x'.repeat(600)}  ` }] },
  ];
  const res = await chat({ rules: [{ match: '.', reply: 'rule' }] }, { model: 'x', messages });
  assert.equal(replyText(res), 'x'.repeat(500));
});

test('a matching rule calls an offered tool, filling capture groups', async () => {
  const rules = [{ match: 'weather in (\\w+)', tool: 'forecast', args: { city: '{{1}}', nested: ['{{1}}!'], n: 2 } }];
  const res = await chat({ rules }, ask('Weather in Rome?', { tools: [tool('weather__forecast')] }));
  assert.equal(res.finish, 'tools');
  assert.equal(replyText(res), '');
  assert.deepEqual(callsOf(res.message), [{ type: 'call', id: 'call_1', tool: 'weather__forecast', args: { city: 'Rome', nested: ['Rome!'], n: 2 } }]);
});

test('a rule falls back to its reply when the tool is not offered', async () => {
  const rules = [{ match: 'hi (\\w+)', tool: 'greet', reply: 'Hello {{1}}!' }];
  assert.equal(replyText(await chat({ rules }, ask('hi Ann'))), 'Hello Ann!');
});

test('the first applicable rule wins and non-matching rules are skipped', async () => {
  const rules = [{ match: 'nope', reply: 'a' }, { match: 'yes', reply: 'b' }, { match: 'yes', reply: 'c' }];
  assert.equal(replyText(await chat({ rules }, ask('YES'))), 'b');
});

test('without rules a forced toolMode calls the first or the named tool with empty arguments', async () => {
  const tools = [tool('a'), tool('b')];
  const first = await chat({}, ask('go', { tools, toolMode: 'required' }));
  assert.equal(callsOf(first.message)[0]?.tool, 'a');
  const named = await chat({}, ask('go', { tools, toolMode: { tool: 'b' } }));
  assert.deepEqual(callsOf(named.message).map(({ tool, args }) => ({ tool, args })), [{ tool: 'b', args: {} }]);
  const none = await chat({}, ask('go', { tools, toolMode: 'none' }));
  assert.equal(callsOf(none.message).length, 0);
  assert.equal(none.finish, 'end');
});

test('answers with the first retrieved passage, without its source prefix', async () => {
  const context = '<context type="knowledge" trust="untrusted">\nReference passages.\n[1] (docs) Refunds take 5 days.\n[2] (docs) Other.\n</context>';
  const res = await chat({}, { model: 'x', messages: [textMessage('system', context), textMessage('user', 'refund time?')] });
  assert.equal(replyText(res), 'Refunds take 5 days.');
  const bare = await chat({}, ask(`${context.replace(' (docs)', '')}\nrefund time?`));
  assert.equal(replyText(bare), 'Refunds take 5 days.');
});

test('stream yields word deltas, call deltas and one final end delta with usage', async () => {
  const model = createMockModel();
  const deltas: ModelDelta[] = [];
  for await (const d of model.stream!(ask('one two three'), testContext())) deltas.push(d);
  const words = deltas.flatMap((d) => (d.type === 'text' ? [d.text] : []));
  assert.equal(words.join(''), 'You said: one two three');
  assert.ok(words.length > 3);
  const last = deltas.at(-1)!;
  assert.equal(last.type, 'end');
  assert.equal(deltas.filter((d) => d.type === 'end').length, 1);
  assert.ok(last.type === 'end' && last.finish === 'end' && last.usage);
  assert.equal(replyText(assembleDeltas(deltas)), 'You said: one two three');

  const calls: ModelDelta[] = [];
  for await (const d of model.stream!(ask('go', { tools: [tool('a')], toolMode: 'required' }), testContext())) calls.push(d);
  const assembled = assembleDeltas(calls);
  assert.equal(assembled.finish, 'tools');
  assert.equal(callsOf(assembled.message)[0]?.tool, 'a');
});

test('an aborted signal rejects with AbortError, also while waiting for latency', async () => {
  const model = createMockModel({ latencyMs: 5000 });
  const done = new AbortController();
  done.abort();
  await assert.rejects(model.chat(ask('x'), testContext({ signal: done.signal })), { name: 'AbortError' });
  const ac = new AbortController();
  const pending = model.chat(ask('x'), testContext({ signal: ac.signal }));
  ac.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('the model option is reported in replies', async () => {
  assert.equal((await chat({ model: 'scripted-1' }, ask('x'))).model, 'scripted-1');
});
