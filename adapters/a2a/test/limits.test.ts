import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { AdapterRegistry, compose, noopTelemetry, resolveProfile } from '@agent-layers/core';
import { serveStack } from '@agent-layers/gateway';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { identityAdapter } from '@agent-layers/adapter-static-identity';
import { channelAdapter, runtimeAdapter } from '../src/index.ts';

const ctx = { name: 'a2a', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const completed = (text: string) => ({ jsonrpc: '2.0', id: 1, result: { task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'a', parts: [{ text }] }] } } });
const working = { jsonrpc: '2.0', id: 1, result: { task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING' } } } };

async function remoteAgent(handler: (n: number, res: import('node:http').ServerResponse) => void) {
  let n = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    handler(++n, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => { server.closeAllConnections(); server.close(); } };
}

async function runtimeFor(url: string, options: Record<string, unknown>) {
  const client = await compose(resolveProfile({
    agents: { assistant: { instructions: '', model: 'remote' } },
    layers: { runtime: { adapter: 'a2a', options: { url, ...options } } },
  }), { adapters: [runtimeAdapter] });
  return client;
}

test('timeoutMs ends a run whose remote agent does not answer', async () => {
  const remote = await remoteAgent(() => { /* never answers */ });
  const client = await runtimeFor(remote.url, { timeoutMs: 100 });
  try {
    const started = Date.now();
    const r = await (await client.agent('assistant')).run('hi');
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'remote agent timed out');
    assert.ok(Date.now() - started < 5000);
  } finally {
    await client.close();
    remote.close();
  }
});

test('pollMs sets the wait between GetTask calls', async () => {
  const remote = await remoteAgent((n, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(n < 3 ? working : completed('done'))));
  const client = await runtimeFor(remote.url, { pollMs: 10 });
  try {
    const started = Date.now();
    const r = await (await client.agent('assistant')).run('hi');
    assert.equal(r.output, 'done');
    assert.ok(Date.now() - started < 400, 'two polls at 10 ms, not at the 500 ms default');
  } finally {
    await client.close();
    remote.close();
  }
});

test('maxTasksPerCaller refuses a task over the cap', async () => {
  const stack = await compose(resolveProfile({
    agents: { assistant: { instructions: 'Be brief.', model: 'mock' } },
    layers: {
      model: { adapter: 'mock-model', options: { latencyMs: 1500, rules: [{ match: 'ping', reply: 'pong' }] } },
      runtime: { adapter: 'basic-runtime' },
      identity: { adapter: 'static-identity', options: { tokens: { 'dev-token': { subject: 'dev-user' } } } },
      channels: [{ adapter: 'a2a', options: { maxTasks: 4, maxTasksPerCaller: 1 } }],
    },
  }), { adapters: [mockModel, basicRuntime, identityAdapter, channelAdapter] });
  const gw = await serveStack(stack, { port: 0 });
  try {
    const send = async () => (await fetch(`${gw.url}/a2a/assistant`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: `m-${Math.random()}`, role: 'ROLE_USER', parts: [{ text: 'ping' }] }, configuration: { returnImmediately: true } } }),
    })).json() as Promise<{ result?: unknown; error?: { code: number; message: string } }>;
    assert.ok((await send()).result);
    assert.match((await send()).error!.message, /too many tasks in progress/);
  } finally {
    await gw.close();
    await stack.close();
  }
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(channelAdapter).register(runtimeAdapter);
  await registry.create('ChannelPort', 'a2a', { maxTasks: '400', maxTasksPerCaller: '10', taskTtlMs: '60000' }, ctx);
  await registry.create('ChannelPort', 'a2a', { maxTasks: 'unbounded' }, ctx);
  await registry.create('RuntimePort', 'a2a', { url: 'http://127.0.0.1:9/', timeoutMs: '5000', pollMs: '100' }, ctx);
  await registry.create('RuntimePort', 'a2a', { url: 'http://127.0.0.1:9/', timeoutMs: 'unbounded' }, ctx);
  await assert.rejects(registry.create('ChannelPort', 'a2a', { maxTasks: 3 }, ctx), /maxTasks/);
  await assert.rejects(registry.create('ChannelPort', 'a2a', { maxTasksPerCaller: 0 }, ctx), /maxTasksPerCaller/);
  await assert.rejects(registry.create('ChannelPort', 'a2a', { taskTtlMs: 'unbounded' }, ctx), /taskTtlMs/);
  await assert.rejects(registry.create('ChannelPort', 'a2a', { maxTasks: 40, maxTasksPerCaller: 11 }, ctx), /quarter/);
  await assert.rejects(registry.create('RuntimePort', 'a2a', { url: 'http://127.0.0.1:9/', timeoutMs: 0 }, ctx), /timeoutMs/);
  await assert.rejects(registry.create('RuntimePort', 'a2a', { url: 'http://127.0.0.1:9/', pollMs: 'unbounded' }, ctx), /pollMs/);
});
