import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry, type CallContext } from '@agent-layers/core';
import { adapter, createOpenApiTools } from '../src/index.ts';
import { startApi } from './mock.ts';
import { sampleSpec } from './spec.ts';

const call: CallContext = { runId: 'run-1', agent: 'agent-1' };
const actx = { name: 'api', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };

test('maxResultChars, errorBodyChars and minSecretChars take effect when set', async () => {
  const api = await startApi();
  try {
    const tools = await createOpenApiTools({ spec: sampleSpec(api.url), maxResultChars: 10, errorBodyChars: 3 });
    assert.equal((await tools.callTool('getStatus', { code: 500 }, call)).content, 'HTTP 500 Internal Server Error: sta…');
    const keyed = await createOpenApiTools({ spec: sampleSpec(api.url), headers: { 'x-api-key': 'abc' } });
    assert.equal(((await keyed.callTool('echoQuery', { message: 'hi' }, call)).data as { headers: Record<string, string> }).headers['x-api-key'], 'abc'); // below the default minimum of 4
    const masked = await createOpenApiTools({ spec: sampleSpec(api.url), headers: { 'x-api-key': 'abc' }, minSecretChars: 3 });
    assert.equal(((await masked.callTool('echoQuery', { message: 'hi' }, call)).data as { headers: Record<string, string> }).headers['x-api-key'], '[redacted]');
    const short = await createOpenApiTools({ spec: sampleSpec(api.url), maxResultChars: 10 });
    assert.match((await short.callTool('echoQuery', { message: 'hi' }, call)).content, /\n\[truncated: \d+ chars in total\]$/);
  } finally {
    await api.close();
  }
});

test('maxDescriptionChars and maxRefDepth take effect when set', async () => {
  const spec = sampleSpec('http://127.0.0.1:9');
  spec.paths['/echo'].get.summary = 'z'.repeat(50);
  const chain = (n: number): Record<string, any> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`L${i}`, { type: 'object', properties: i + 1 < n ? { next: { $ref: `#/components/schemas/L${i + 1}` } } : { end: { type: 'string' } } }]));
  Object.assign(spec.components.schemas, chain(8));
  spec.paths['/echo'].post.requestBody.content['application/json'].schema = { $ref: '#/components/schemas/L0' };
  const depth = (node: any): number => (node?.properties?.next ? 1 + depth(node.properties.next) : 0);
  const find = async (opts: object) => {
    const specs = await (await createOpenApiTools({ spec, ...opts })).listTools(call);
    return { echoQuery: specs.find((s) => s.name === 'echoQuery')!, echoJson: specs.find((s) => s.name === 'echoJson')! };
  };
  const full = await find({});
  assert.equal(full.echoQuery.description, 'z'.repeat(50));
  assert.equal(depth(full.echoJson.inputSchema), 7); // L1..L7 below the merged top level
  const cut = await find({ maxDescriptionChars: 10, maxRefDepth: 3 });
  assert.equal(cut.echoQuery.description, `${'z'.repeat(10)}…`);
  assert.ok(depth(cut.echoJson.inputSchema) < 7);
});

test('specTimeoutMs stops a spec fetch that never answers', async () => {
  const server = createServer(() => { /* never answers */ });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/spec.json`;
  try {
    await assert.rejects(createOpenApiTools({ spec: url, baseUrl: 'http://127.0.0.1:9', specTimeoutMs: 50 }), /timeout|aborted/i);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  const make = (options: Record<string, unknown>) => registry.create('ToolPort', 'openapi', { spec: sampleSpec('http://127.0.0.1:9'), ...options }, actx);
  await make({ timeoutMs: '2500', maxResultChars: '500', errorBodyChars: '10', minSecretChars: '2', specTimeoutMs: '1000', maxDescriptionChars: '200', maxRefDepth: '8' });
  await make({ timeoutMs: 'unbounded', maxResultChars: 'unbounded', specTimeoutMs: 'unbounded' });
  await assert.rejects(make({ timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(make({ maxResultChars: -1 }), /maxResultChars/);
  await assert.rejects(make({ specTimeoutMs: 0 }), /specTimeoutMs/);
  await assert.rejects(make({ maxDescriptionChars: 'unbounded' }), /maxDescriptionChars/);
  await assert.rejects(make({ maxRefDepth: 0 }), /maxRefDepth/);
  await assert.rejects(make({ errorBodyChars: 'unbounded' }), /errorBodyChars/);
  await assert.rejects(make({ minSecretChars: 0 }), /minSecretChars/);
});
