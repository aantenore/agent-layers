import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry, type CallContext } from '@agent-layers/core';
import { adapter, createHttpTools } from '../src/index.ts';
import { startApi } from './mock.ts';

const call: CallContext = { runId: 'run-1', agent: 'agent-1' };
const actx = { name: 'api', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const tool = { description: 'T', method: 'GET', url: 'http://127.0.0.1:9/x' } as const;

test('maxResultChars, errorBodyChars and minSecretChars take effect when set; a tool value wins over the option', async () => {
  const api = await startApi();
  try {
    const tools = createHttpTools({
      maxResultChars: 10, errorBodyChars: 3, minSecretChars: 3,
      tools: {
        big: { description: 'Big', method: 'GET', url: `${api.url}/big` },
        bigger: { description: 'Bigger', method: 'GET', url: `${api.url}/big`, maxResultChars: 20 },
        fail: { description: 'Fail', method: 'GET', url: `${api.url}/status/500` },
      },
    });
    assert.match((await tools.callTool('big', {}, call)).content, /^x{10}\n\[truncated: 100 chars/);
    assert.match((await tools.callTool('bigger', {}, call)).content, /^x{20}\n\[truncated/);
    assert.equal((await tools.callTool('fail', {}, call)).content, 'HTTP 500 Internal Server Error: sta…');
    const keyed = createHttpTools({ minSecretChars: 3, tools: { keyed: { description: 'Keyed', method: 'GET', url: `${api.url}/echo`, headers: { 'x-api-key': 'abc' } } } });
    assert.equal(((await keyed.callTool('keyed', {}, call)).data as { headers: Record<string, string> }).headers['x-api-key'], '[redacted]');
    // The default minimum (4) leaves a 3-character value alone.
    const plain = createHttpTools({ tools: { keyed: { description: 'Keyed', method: 'GET', url: `${api.url}/echo`, headers: { 'x-api-key': 'abc' } } } });
    assert.equal(((await plain.callTool('keyed', {}, call)).data as { headers: Record<string, string> }).headers['x-api-key'], 'abc');
  } finally {
    await api.close();
  }
});

test('timeoutMs stops a request that never answers; a tool value wins over the option', async () => {
  const server = createServer(() => { /* never answers */ });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/slow`;
  try {
    const tools = createHttpTools({ timeoutMs: 60_000, tools: { slow: { description: 'S', method: 'GET', url, timeoutMs: 50 } } });
    await assert.rejects(tools.callTool('slow', {}, call), /timeout|aborted/i);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('limits from ${env:...} are coerced to numbers, also per tool; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  const make = (options: Record<string, unknown>) => registry.create('ToolPort', 'http-tools', { tools: { t: tool }, ...options }, actx);
  await make({ timeoutMs: '2500', maxResultChars: '500', errorBodyChars: '10', minSecretChars: '2' });
  await make({ tools: { t: { ...tool, timeoutMs: '1500', maxResultChars: '300' } } });
  await make({ timeoutMs: 'unbounded', maxResultChars: 'unbounded' });
  await make({ tools: { t: { ...tool, timeoutMs: 'unbounded' } } });
  await assert.rejects(make({ timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(make({ maxResultChars: -1 }), /maxResultChars/);
  await assert.rejects(make({ errorBodyChars: 'unbounded' }), /errorBodyChars/);
  await assert.rejects(make({ minSecretChars: 0 }), /minSecretChars/);
  await assert.rejects(make({ tools: { t: { ...tool, timeoutMs: 0 } } }), /timeoutMs/);
  await assert.rejects(make({ tools: { t: { ...tool, maxResultChars: '0' } } }), /maxResultChars/);
});
