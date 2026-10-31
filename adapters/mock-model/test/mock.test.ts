import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testContext } from '@agent-layers/conformance';
import { assembleChunks, type ChatChunk, type ChatMessage, type ChatRequest, type ChatTool } from '@agent-layers/core';
import { createMockModel, type MockModelOptions } from '../src/index.ts';

const tool = (name: string): ChatTool => ({ type: 'function', function: { name } });
const ask = (text: string, extra: Partial<ChatRequest> = {}): ChatRequest => ({ model: 'x', messages: [{ role: 'user', content: text }], ...extra });
const chat = (options: MockModelOptions, req: ChatRequest) => createMockModel(options).chat(req, testContext());

test('echoes the last user message by default', async () => {
  const res = await chat({}, ask('hello there'));
  assert.equal(res.model, 'mock');
  assert.equal(res.choices[0]?.message.content, 'You said: hello there');
  assert.equal(res.choices[0]?.finish_reason, 'stop');
});

test('usage is derived from character counts', async () => {
  const res = await chat({}, ask('12345678'));
  // prompt 8 chars -> 2 tokens; "You said: 12345678" is 18 chars -> 5 tokens
  assert.deepEqual(res.usage, { prompt_tokens: 2, completion_tokens: 5, total_tokens: 7 });
});

test('a tool result becomes the final answer, trimmed and capped', async () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'time?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'clock__now', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: `  ${'x'.repeat(600)}  ` },
  ];
  const res = await chat({ rules: [{ match: '.', reply: 'rule' }] }, { model: 'x', messages });
  assert.equal(res.choices[0]?.message.content, 'x'.repeat(500));
});

test('a matching rule calls an offered tool, filling capture groups', async () => {
  const rules = [{ match: 'weather in (\\w+)', tool: 'forecast', args: { city: '{{1}}', nested: ['{{1}}!'], n: 2 } }];
  const res = await chat({ rules }, ask('Weather in Rome?', { tools: [tool('weather__forecast')] }));
  const choice = res.choices[0]!;
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.content, null);
  assert.deepEqual(choice.message.tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'weather__forecast', arguments: '{"city":"Rome","nested":["Rome!"],"n":2}' } },
  ]);
});

test('a rule falls back to its reply when the tool is not offered', async () => {
  const rules = [{ match: 'hi (\\w+)', tool: 'greet', reply: 'Hello {{1}}!' }];
  assert.equal((await chat({ rules }, ask('hi Ann'))).choices[0]?.message.content, 'Hello Ann!');
});

test('the first applicable rule wins and non-matching rules are skipped', async () => {
  const rules = [{ match: 'nope', reply: 'a' }, { match: 'yes', reply: 'b' }, { match: 'yes', reply: 'c' }];
  assert.equal((await chat({ rules }, ask('YES'))).choices[0]?.message.content, 'b');
});

test('without rules a forced tool_choice calls the first or the named tool with empty arguments', async () => {
  const tools = [tool('a'), tool('b')];
  const first = await chat({}, ask('go', { tools, tool_choice: 'required' }));
  assert.equal(first.choices[0]?.message.tool_calls?.[0]?.function.name, 'a');
  const named = await chat({}, ask('go', { tools, tool_choice: { type: 'function', function: { name: 'b' } } }));
  assert.deepEqual(named.choices[0]?.message.tool_calls?.[0]?.function, { name: 'b', arguments: '{}' });
  const none = await chat({}, ask('go', { tools, tool_choice: 'none' }));
  assert.equal(none.choices[0]?.message.tool_calls, undefined);
});

test('answers with the first retrieved passage, without its source prefix', async () => {
  const context = '<context type="knowledge" trust="untrusted">\nReference passages.\n[1] (docs) Refunds take 5 days.\n[2] (docs) Other.\n</context>';
  const res = await chat({}, { model: 'x', messages: [{ role: 'system', content: context }, { role: 'user', content: 'refund time?' }] });
  assert.equal(res.choices[0]?.message.content, 'Refunds take 5 days.');
  const bare = await chat({}, ask(`${context.replace(' (docs)', '')}\nrefund time?`));
  assert.equal(bare.choices[0]?.message.content, 'Refunds take 5 days.');
});

test('stream yields word chunks, tool calls and a final chunk with usage', async () => {
  const model = createMockModel();
  const chunks: ChatChunk[] = [];
  for await (const c of model.stream!(ask('one two three'), testContext())) chunks.push(c);
  const words = chunks.flatMap((c) => c.choices[0]?.delta.content ?? []);
  assert.equal(words.join(''), 'You said: one two three');
  assert.ok(words.length > 3);
  assert.equal(chunks[0]?.choices[0]?.delta.role, 'assistant');
  const last = chunks.at(-1)!;
  assert.equal(last.choices[0]?.finish_reason, 'stop');
  assert.ok(last.usage);
  assert.deepEqual(assembleChunks(chunks).choices[0]?.message.content, 'You said: one two three');

  const calls: ChatChunk[] = [];
  for await (const c of model.stream!(ask('go', { tools: [tool('a')], tool_choice: 'required' }), testContext())) calls.push(c);
  const assembled = assembleChunks(calls);
  assert.equal(assembled.choices[0]?.finish_reason, 'tool_calls');
  assert.equal(assembled.choices[0]?.message.tool_calls?.[0]?.function.name, 'a');
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

test('the model option is reported in responses', async () => {
  assert.equal((await chat({ model: 'scripted-1' }, ask('x'))).model, 'scripted-1');
});
