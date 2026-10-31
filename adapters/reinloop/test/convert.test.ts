import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message as SdkMessage, ModelReply } from '@agent-layers/core';
import type { RunEvent as LoopEvent } from 'reinloop';
import { fromMessages, fromModelReply, toModelRequest, toMessages } from '../src/convert.ts';
import { mapEvent } from '../src/events.ts';

const text = (role: SdkMessage['role'], t: string): SdkMessage => ({ role, parts: [{ type: 'text', text: t }] });

test('reinloop request → SDK request: instructions, parts, tools and settings', () => {
  const req = toModelRequest({
    model: 'm', instructions: 'be brief',
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'weather?' }] },
      { role: 'assistant', parts: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'checking' }, { type: 'tool_call', id: 'c1', name: 'w', args: { city: 'Rome' } }] },
      { role: 'tool', parts: [{ type: 'tool_result', callId: 'c1', name: 'w', content: 'sunny' }, { type: 'tool_result', callId: 'c2', name: 'w', content: 'bad', isError: true }] },
    ],
    tools: [{ name: 'w', description: 'Weather', schema: { type: 'object' } }],
    params: { temperature: 0.1, maxTokens: 20, stop: ['x'], topP: 0.9, extra: { seed: 1 } },
  }, { 'openai.seed': 1 });
  assert.deepEqual(req, {
    model: 'm',
    messages: [
      text('system', 'be brief'),
      text('user', 'weather?'),
      { role: 'assistant', parts: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'checking' }, { type: 'call', id: 'c1', tool: 'w', args: { city: 'Rome' } }] },
      { role: 'tool', parts: [{ type: 'result', callId: 'c1', ok: true, text: 'sunny' }, { type: 'result', callId: 'c2', ok: false, text: 'bad' }] },
    ],
    tools: [{ name: 'w', description: 'Weather', params: { type: 'object' } }],
    settings: { temperature: 0.1, maxOutputTokens: 20, stop: ['x'] },
    ext: { 'openai.seed': 1 },
  });
  assert.deepEqual(toMessages(undefined, []), []);
});

test('SDK reply → reinloop response: parts, usage, finish and invalid arguments', () => {
  const reply: ModelReply = {
    model: 'served', finish: 'tools', usage: { inputTokens: 5, outputTokens: 7 },
    message: { role: 'assistant', parts: [
      { type: 'reasoning', text: 'think' }, { type: 'text', text: 'ok' },
      { type: 'call', id: 'a', tool: 't', args: { x: 1 } }, { type: 'call', id: 'b', tool: 't', args: {}, invalid: '{oops' },
    ] },
  };
  const res = fromModelReply(reply, 'asked');
  assert.equal(res.model, 'served');
  assert.equal(res.stopReason, 'tool_calls');
  assert.deepEqual(res.usage, { inputTokens: 5, outputTokens: 7 });
  assert.deepEqual(res.message.parts, [
    { type: 'thinking', text: 'think' }, { type: 'text', text: 'ok' },
    { type: 'tool_call', id: 'a', name: 't', args: { x: 1 } },
    { type: 'tool_call', id: 'b', name: 't', args: {}, argsIssue: { error: 'arguments must be a JSON object', repaired: false } },
  ]);
  const finishes = (['end', 'limit', 'refused', 'other', 'custom'] as const).map((finish) => fromModelReply({ model: '', finish, message: { role: 'assistant', parts: [] } }, 'asked').stopReason);
  assert.deepEqual(finishes, ['end', 'max_tokens', 'refusal', 'other', 'other']);
  assert.equal(fromModelReply({ model: '', finish: 'end', message: { role: 'assistant', parts: [] } }, 'asked').model, 'asked');
});

test('SDK input messages → reinloop messages: system joins the instructions, results keep the tool name', () => {
  const { system, messages } = fromMessages([
    text('system', 'rules'), text('user', 'go'),
    { role: 'assistant', parts: [{ type: 'call', id: 'c1', tool: 'lookup', args: {} }] },
    { role: 'tool', parts: [{ type: 'result', callId: 'c1', ok: false, text: 'nope' }] },
  ]);
  assert.deepEqual(system, ['rules']);
  assert.deepEqual(messages, [
    { role: 'user', parts: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'lookup', args: {} }] },
    { role: 'tool', parts: [{ type: 'tool_result', callId: 'c1', name: 'lookup', content: 'nope', isError: true }] },
  ]);
});

const event = (type: string, data: object): LoopEvent => ({ runId: 'r1', seq: 1, ts: 0, type, data }) as LoopEvent;

test('reinloop events map to core run events and namespaced events', () => {
  const opts = { stream: false };
  assert.deepEqual(mapEvent(event('run_start', { agent: 'a', resumed: false }), opts), [{ type: 'run.start', runId: 'r1', agent: 'a' }]);
  const response = (stopReason: string, parts: object[], extra = {}) => event('model_response', {
    turn: 2, model: 'm', message: { role: 'assistant', parts }, usage: { inputTokens: 4, outputTokens: 1 }, stopReason, latencyMs: 1, costUsd: 0.5, ...extra,
  });
  assert.deepEqual(mapEvent(response('tool_calls', [{ type: 'tool_call', id: 'c', name: 't', args: {} }]), opts), [
    { type: 'model.reply', turn: 2, model: 'm', finish: 'tools', calls: 1 },
    { type: 'reinloop.usage', turn: 2, usage: { inputTokens: 4, outputTokens: 1 }, costUsd: 0.5 },
  ]);
  assert.deepEqual(mapEvent(response('max_tokens', [{ type: 'text', text: 'x' }]), opts)[0], { type: 'model.reply', turn: 2, model: 'm', finish: 'limit', calls: 0 });
  assert.deepEqual(mapEvent(response('end', [], { discarded: true }), opts), []);
  assert.deepEqual(mapEvent(event('tool_start', { callId: 'c', name: 't', args: { secret: 1 } }), opts), [{ type: 'tool.call', id: 'c', tool: 't' }]);
  assert.deepEqual(mapEvent(event('tool_result', { callId: 'c', name: 't', content: 'out', isError: true, durationMs: 3 }), opts), [{ type: 'tool.result', id: 'c', tool: 't', ok: false, durationMs: 3 }]);
  assert.deepEqual(mapEvent(event('tool_args_invalid', { callId: 'c', name: 't', error: 'bad', repaired: true }), opts), [{ type: 'reinloop.args_invalid', id: 'c', tool: 't', repaired: true }]);
  assert.deepEqual(mapEvent(event('compaction', { strategy: 'window', beforeTokens: 9, afterTokens: 3, messages: [] }), opts), [{ type: 'reinloop.compaction', strategy: 'window', beforeTokens: 9, afterTokens: 3 }]);
  assert.deepEqual(mapEvent(event('text_delta', { text: 'hi' }), opts), []);
  assert.deepEqual(mapEvent(event('text_delta', { text: 'hi' }), { stream: true }), [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(mapEvent(event('tool_decision', { callId: 'c', name: 't', allowed: true, reason: '' }), opts), []);
  assert.deepEqual(mapEvent(event('turn_start', { turn: 1 }), opts), []);
});
