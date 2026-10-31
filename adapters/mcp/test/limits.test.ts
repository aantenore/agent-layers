import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry, type CallContext, type ChannelHost } from '@agent-layers/core';
import { channelAdapter, createMcpKnowledge, createMcpServerChannel, createMcpTools, knowledgeAdapter, McpHttpError, McpSession, toolAdapter } from '../src/index.ts';
import { startMcpMock } from './mock.ts';

const ctx: CallContext = { runId: 'run-1', agent: 'agent-1' };
const actx = { name: 'mcp', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const stdioServer = fileURLToPath(new URL('./stdio-server.ts', import.meta.url));

test('errorBodyChars cuts HTTP error bodies and knowledge error results', async () => {
  const mock = await startMcpMock({ echoErrors: 'http' });
  const tools = createMcpTools({ url: mock.url, errorBodyChars: 12 });
  try {
    await assert.rejects(tools.callTool('echo', { text: 'x' }, ctx), (err: Error) => err instanceof McpHttpError && err.message === 'MCP HTTP 500: upstream fai');
  } finally {
    await tools.close?.();
    await mock.close();
  }
  const plain = await startMcpMock();
  const source = createMcpKnowledge({ url: plain.url, tool: 'fail', errorBodyChars: 2 });
  try {
    await assert.rejects(source.search({ query: 'q' }), (err: Error) => err.message === 'MCP tool fail failed: it');
  } finally {
    await source.close?.();
    await plain.close();
  }
});

test('minSecretChars decides which header values are masked in errors', async () => {
  const mock = await startMcpMock({ echoErrors: 'rpc' });
  const make = (minSecretChars?: number) => createMcpTools({ url: mock.url, headers: { 'x-api-key': 'abc' }, ...(minSecretChars ? { minSecretChars } : {}) });
  const kept = make();
  const masked = make(3);
  try {
    assert.match((await kept.callTool('echo', { text: 'x' }, ctx)).content, /abc/);
    assert.equal((await masked.callTool('echo', { text: 'x' }, ctx)).content.includes('abc'), false);
  } finally {
    await kept.close?.();
    await masked.close?.();
    await mock.close();
  }
});

test('timeoutMs stops a stdio server that never answers; stderrChars keeps the tail of its stderr', async () => {
  const silent = createMcpTools({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 100 });
  try {
    await assert.rejects(silent.listTools(ctx), /timed out after 100ms/);
  } finally {
    await silent.close?.();
  }
  const session = new McpSession({ command: process.execPath, args: [stdioServer], timeoutMs: 10_000, stderrChars: 5 });
  try {
    await assert.rejects(session.run((c) => c.callTool('crash', {})), /exited with code 3: rted$/);
  } finally {
    await session.close();
  }
});

test('toolsTtlMs sets how long the tool list is cached', async () => {
  const mock = await startMcpMock();
  const lists = () => mock.requests.filter((r) => r.rpc === 'tools/list').length;
  const cached = createMcpTools({ url: mock.url, toolsTtlMs: 60_000 });
  const fresh = createMcpTools({ url: mock.url, toolsTtlMs: 0 });
  try {
    await cached.listTools(ctx);
    await cached.listTools(ctx);
    assert.equal(lists(), 2); // two pages, loaded once
    await fresh.listTools(ctx);
    await fresh.listTools(ctx);
    assert.equal(lists(), 6);
  } finally {
    await cached.close?.();
    await fresh.close?.();
    await mock.close();
  }
});

test('k limits the passages when the query has no k', async () => {
  const mock = await startMcpMock();
  const all = createMcpKnowledge({ url: mock.url, tool: 'search' });
  const one = createMcpKnowledge({ url: mock.url, tool: 'search', k: 1 });
  try {
    assert.equal((await all.search({ query: 'tide vault quay' })).length, 3);
    assert.equal((await one.search({ query: 'tide vault quay' })).length, 1);
  } finally {
    await all.close?.();
    await one.close?.();
    await mock.close();
  }
});

test('maxSessionsPerCaller caps the anonymous pool; the per-caller cap stays under a quarter of maxSessions', async () => {
  const host = {} as ChannelHost;
  const mount = await createMcpServerChannel({ maxSessions: 8, maxSessionsPerCaller: 1 }).mount!(host);
  const route = mount.routes[0]!;
  const init = () => route.handle(new Request('http://x/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
  }), { signal: new AbortController().signal, requestId: 'r1', origin: 'http://x' });
  assert.equal((await init()).status, 200);
  assert.equal((await init()).status, 429);
  assert.throws(() => createMcpServerChannel({ maxSessions: 8, maxSessionsPerCaller: 3 }), /quarter/);
  await mount.close?.();
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected, per descriptor', async () => {
  const registry = new AdapterRegistry().register(toolAdapter).register(knowledgeAdapter).register(channelAdapter);
  const tools = (options: Record<string, unknown>) => registry.create('ToolPort', 'mcp', { url: 'http://127.0.0.1:9/mcp', ...options }, actx);
  const knowledge = (options: Record<string, unknown>) => registry.create('KnowledgePort', 'mcp', { url: 'http://127.0.0.1:9/mcp', tool: 'search', ...options }, actx);
  const channel = (options: Record<string, unknown>) => registry.create('ChannelPort', 'mcp', options, actx);

  await tools({ timeoutMs: '2500', toolsTtlMs: '0', errorBodyChars: '10', minSecretChars: '2', stderrChars: '100' });
  await tools({ timeoutMs: 'unbounded' });
  await assert.rejects(tools({ timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(tools({ toolsTtlMs: 'unbounded' }), /toolsTtlMs/);
  await assert.rejects(tools({ errorBodyChars: 'unbounded' }), /errorBodyChars/);
  await assert.rejects(tools({ minSecretChars: 0 }), /minSecretChars/);
  await assert.rejects(tools({ stderrChars: -1 }), /stderrChars/);

  await knowledge({ k: '3', timeoutMs: '1000', errorBodyChars: '20' });
  await assert.rejects(knowledge({ k: 0 }), /options\.k/);
  await assert.rejects(knowledge({ k: 'unbounded' }), /options\.k/);

  await channel({ sessionTtlMs: '60000', maxSessionAgeMs: '120000', maxSessions: '100', maxSessionsPerCaller: '5' });
  await channel({ sessionTtlMs: 'unbounded', maxSessionAgeMs: 'unbounded', maxSessions: 'unbounded', maxSessionsPerCaller: 'unbounded' });
  await assert.rejects(channel({ sessionTtlMs: 999 }), /sessionTtlMs/);
  await assert.rejects(channel({ maxSessions: 0 }), /maxSessions/);
  await assert.rejects(channel({ maxSessionsPerCaller: -1 }), /maxSessionsPerCaller/);
});
