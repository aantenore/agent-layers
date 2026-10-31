import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testContext } from '@agent-layers/conformance';
import { textMessage, type Message, type ModelRequest, type ToolInfo } from '@agent-layers/core';
import { createRuleRouter, estimateTokens, type RuleRouterOptions } from '../src/index.ts';

const tool: ToolInfo = { name: 'crm__get', description: 'Reads a record', params: { type: 'object' } };
const req = (over: Partial<ModelRequest> & { text?: string } = {}): ModelRequest => {
  const { text, ...rest } = over;
  return { model: 'asked', messages: [textMessage('user', text ?? 'hello')], ...rest };
};
const pick = async (o: RuleRouterOptions, r: ModelRequest) => createRuleRouter(o).select(r, testContext());
const assistant = (text: string): Message => textMessage('assistant', text);

test('the first matching rule wins; otherwise the default; otherwise the requested model', async () => {
  const o: RuleRouterOptions = { rules: [{ when: { hasTools: true }, model: 'tool-model' }, { when: { hasTools: true, maxEstTokens: 5 }, model: 'never' }], default: 'fallback' };
  assert.equal(await pick(o, req({ tools: [tool] })), 'tool-model');
  assert.equal(await pick(o, req()), 'fallback');
  assert.equal(await pick({ rules: o.rules }, req()), 'asked');
});

test('token bounds use the size estimate, inclusive on both ends', async () => {
  const o: RuleRouterOptions = { rules: [{ when: { maxEstTokens: 10 }, model: 'small' }, { when: { minEstTokens: 100 }, model: 'big' }], default: 'mid' };
  assert.equal(estimateTokens(req({ text: 'x'.repeat(40) })), 10);
  assert.equal(await pick(o, req({ text: 'x'.repeat(40) })), 'small');
  assert.equal(await pick(o, req({ text: 'x'.repeat(41) })), 'mid');
  assert.equal(await pick(o, req({ text: 'x'.repeat(400) })), 'big');
});

test('the estimate counts all messages, content parts, tool calls and tool definitions', () => {
  const plain = estimateTokens(req({ text: 'abcd' }));
  assert.equal(plain, 1);
  assert.ok(estimateTokens(req({ text: 'abcd', tools: [tool] })) > plain);
  const parts = estimateTokens({ model: 'm', messages: [{ role: 'user', parts: [{ type: 'text', text: 'x'.repeat(40) }, { type: 'media', mediaType: 'image/png', url: 'ignored' }] }] });
  assert.equal(parts, 10);
  const withCall = estimateTokens({ model: 'm', messages: [{ role: 'assistant', parts: [{ type: 'call', id: '1', tool: 'a', args: {} }] }] });
  assert.ok(withCall > 0);
  const withResult = estimateTokens({ model: 'm', messages: [{ role: 'tool', parts: [{ type: 'result', callId: '1', ok: true, text: 'x'.repeat(40) }] }] });
  assert.equal(withResult, 10);
});

test('hasTools false matches requests without tools, and toolMode none counts as none', async () => {
  const o: RuleRouterOptions = { rules: [{ when: { hasTools: false }, model: 'plain' }], default: 'agentic' };
  assert.equal(await pick(o, req()), 'plain');
  assert.equal(await pick(o, req({ tools: [] })), 'plain');
  assert.equal(await pick(o, req({ tools: [tool] })), 'agentic');
  assert.equal(await pick(o, req({ tools: [tool], toolMode: 'none' })), 'plain');
});

test('turnAtLeast counts the assistant messages already in the conversation', async () => {
  const o: RuleRouterOptions = { rules: [{ when: { turnAtLeast: 3 }, model: 'long-chat' }], default: 'short' };
  assert.equal(await pick(o, req()), 'short');
  assert.equal(await pick(o, req({ messages: [textMessage('user', 'a'), assistant('b'), textMessage('user', 'c')] })), 'short');
  assert.equal(await pick(o, req({ messages: [textMessage('user', 'a'), assistant('b'), textMessage('user', 'c'), assistant('d'), textMessage('user', 'e')] })), 'long-chat');
});

test('all set conditions must hold', async () => {
  const o: RuleRouterOptions = { rules: [{ when: { hasTools: true, minEstTokens: 50 }, model: 'both' }], default: 'no' };
  assert.equal(await pick(o, req({ tools: [tool] })), 'no');
  assert.equal(await pick(o, req({ text: 'x'.repeat(400) })), 'no');
  assert.equal(await pick(o, req({ text: 'x'.repeat(400), tools: [tool] })), 'both');
});

test('invalid rules fail at creation', () => {
  assert.throws(() => createRuleRouter({ rules: [{ when: {}, model: 'm' }] }), /at least one condition/);
  assert.throws(() => createRuleRouter({ rules: [{ when: { hasTools: true }, model: '' }] }), /needs a model/);
  assert.throws(() => createRuleRouter({ rules: [{ when: { minEstTokens: 9, maxEstTokens: 3 }, model: 'm' }] }), /above/);
});

test('select does not modify the request', async () => {
  const r = req({ tools: [tool] });
  const before = JSON.stringify(r);
  await pick({ rules: [{ when: { hasTools: true }, model: 'x' }] }, r);
  assert.equal(JSON.stringify(r), before);
});
