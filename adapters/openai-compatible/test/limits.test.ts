import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry, textMessage, type ModelRequest } from '@agent-layers/core';
import { adapter, createOpenAICompatibleModel } from '../src/index.ts';
import { startMock } from './mock.ts';

const ctx = { runId: 'r', agent: 'a' };
const req: ModelRequest = { model: 'm1', messages: [textMessage('user', 'hi')] };
const adapterCtx = { name: 'llm', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };

test('errorBodyChars and streamEventChars cut the text kept in errors', async () => {
  const mock = await startMock((seen, res) => {
    if (!seen.body.stream) { res.writeHead(500).end('e'.repeat(50)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${'z'.repeat(50)}\n\n`);
  });
  try {
    const model = createOpenAICompatibleModel({ baseUrl: mock.url, errorBodyChars: 10, streamEventChars: 5 });
    await assert.rejects(model.chat(req, ctx), (err: Error) => err.message.endsWith(`: ${'e'.repeat(10)}`));
    await assert.rejects(async () => { for await (const _ of model.stream!(req, ctx)) { /* drain */ } }, (err: Error) => err.message.endsWith(`: ${'z'.repeat(5)}`));
  } finally {
    await mock.close();
  }
});

test('timeoutMs aborts a request that does not answer', async () => {
  const mock = await startMock(() => new Promise(() => { /* never answers */ }));
  try {
    const model = createOpenAICompatibleModel({ baseUrl: mock.url, timeoutMs: 100 });
    await assert.rejects(model.chat(req, ctx), (err: Error) => err.name === 'TimeoutError');
  } finally {
    await mock.close();
  }
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  const make = (options: Record<string, unknown>) => registry.create('ModelPort', 'openai-compatible', { baseUrl: 'http://127.0.0.1:9/v1', ...options }, adapterCtx);
  await make({ timeoutMs: '5000', errorBodyChars: '200', streamEventChars: '50' });
  await make({ timeoutMs: 'unbounded' });
  await assert.rejects(make({ timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(make({ errorBodyChars: 'unbounded' }), /errorBodyChars/);
  await assert.rejects(make({ streamEventChars: -1 }), /streamEventChars/);
  await make({ maxEventChars: '4096' });
  await make({ maxEventChars: 'unbounded' });
  await assert.rejects(make({ maxEventChars: 0 }), /maxEventChars/);
  assert.equal(adapter.limits?.maxEventChars?.default, 1_048_576);
});

test('maxEventChars rejects a stream event longer than the cap', async () => {
  const mock = await startMock((_s, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: {"choices":[{"index":0,"delta":{"content":"${'x'.repeat(200)}"}}]}\n\n`); });
  try {
    const model = createOpenAICompatibleModel({ baseUrl: mock.url, maxEventChars: 100 });
    await assert.rejects(async () => { for await (const _ of model.stream!(req, ctx)) { /* drain */ } }, /maxEventChars/);
  } finally {
    await mock.close();
  }
});
