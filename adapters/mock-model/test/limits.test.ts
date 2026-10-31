import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry, type CallContext, type ChatRequest, type ModelPort } from '@agent-layers/core';
import { adapter } from '../src/index.ts';

const ctx = { name: 'mock', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const call: CallContext = { runId: 'r', agent: 'a' };
const make = (options: Record<string, unknown>) => new AdapterRegistry().register(adapter).create('ModelPort', 'mock-model', options, ctx) as Promise<ModelPort>;
const afterTool: ChatRequest = { model: 'mock', messages: [{ role: 'user', content: 'go' }, { role: 'tool', tool_call_id: 'c1', content: 'r'.repeat(50) }] };

test('toolResultChars and latencyMs take effect (numeric strings, as from ${env:...})', async () => {
  assert.equal((await (await make({})).chat(afterTool, call)).choices[0]!.message.content, 'r'.repeat(50));
  assert.equal((await (await make({ toolResultChars: '10' })).chat(afterTool, call)).choices[0]!.message.content, 'r'.repeat(10));
  const started = Date.now();
  await (await make({ latencyMs: '60' })).chat(afterTool, call);
  assert.ok(Date.now() - started >= 50);
});

test('negative or unbounded values are rejected', async () => {
  await assert.rejects(make({ latencyMs: -1 }), /latencyMs/);
  await assert.rejects(make({ toolResultChars: -1 }), /toolResultChars/);
  await assert.rejects(make({ toolResultChars: 'unbounded' }), /toolResultChars/);
});
