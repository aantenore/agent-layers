import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry, replyText, textMessage, type CallContext, type ModelPort, type ModelRequest } from '@agent-layers/core';
import { adapter } from '../src/index.ts';

const ctx = { name: 'mock', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const call: CallContext = { runId: 'r', agent: 'a' };
const make = (options: Record<string, unknown>) => new AdapterRegistry().register(adapter).create('ModelPort', 'mock-model', options, ctx) as Promise<ModelPort>;
const afterTool: ModelRequest = {
  model: 'mock',
  messages: [textMessage('user', 'go'), { role: 'tool', parts: [{ type: 'result', callId: 'c1', ok: true, text: 'r'.repeat(50) }] }],
};

test('toolResultChars and latencyMs take effect (numeric strings, as from ${env:...})', async () => {
  assert.equal(replyText(await (await make({})).chat(afterTool, call)), 'r'.repeat(50));
  assert.equal(replyText(await (await make({ toolResultChars: '10' })).chat(afterTool, call)), 'r'.repeat(10));
  const started = Date.now();
  await (await make({ latencyMs: '60' })).chat(afterTool, call);
  assert.ok(Date.now() - started >= 50);
});

test('negative or unbounded values are rejected', async () => {
  await assert.rejects(make({ latencyMs: -1 }), /latencyMs/);
  await assert.rejects(make({ toolResultChars: -1 }), /toolResultChars/);
  await assert.rejects(make({ toolResultChars: 'unbounded' }), /toolResultChars/);
});
