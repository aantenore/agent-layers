import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CallContext } from '@agent-layers/core';
import { adapter, createOpenApiTools, type OpenApiOptions } from '../src/index.ts';
import { startApi } from './mock.ts';
import { sampleSpec } from './spec.ts';

const ctx = (over: Partial<CallContext> = {}): CallContext => ({ runId: 'run-1', agent: 'agent-1', ...over });

async function withApi(fn: (url: string, api: Awaited<ReturnType<typeof startApi>>) => Promise<void>, files: Record<string, string> = {}) {
  const api = await startApi(files);
  try { await fn(api.url, api); } finally { await api.close(); }
}

test('lists one tool per operation with schemas built from parameters, bodies and references', () => withApi(async (url) => {
  const tools = await createOpenApiTools({ spec: sampleSpec(url) });
  const specs = await tools.listTools(ctx());
  assert.deepEqual(specs.map((s) => [s.name, s.risk]), [
    ['echoQuery', 'read'], ['echoJson', 'write'], ['wipeEcho', 'write'], ['getStatus', 'read'], ['get_text_value', 'read'], ['putArray', 'write'],
  ]);
  const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
  const query = byName.echoQuery!.inputSchema as { properties: Record<string, any>; required: string[] };
  assert.deepEqual(Object.keys(query.properties), ['message', 'tag', 'x-trace']); // Authorization is handled by the transport
  assert.deepEqual(query.required, ['message']);
  assert.equal(query.properties.message.description, 'Text to echo');
  assert.equal(byName.echoQuery!.description, 'Echo the query');
  const note = byName.echoJson!.inputSchema as { properties: Record<string, any>; required: string[] };
  assert.deepEqual(Object.keys(note.properties), ['title', 'tags', 'parent', 'due']);
  assert.deepEqual(note.required, ['title']);
  assert.deepEqual(note.properties.due.type, ['string', 'null']); // 3.0 nullable
  assert.deepEqual(note.properties.parent, {}); // a reference back to itself is cut
  assert.deepEqual((byName.putArray!.inputSchema as { properties: Record<string, any> }).properties.body.type, 'array');
  assert.equal(byName.getStatus!.description, 'Answer with the status');
  assert.equal(specs.find((s) => s.name === 'upload'), undefined); // multipart bodies are skipped
}));

test('calls operations: path, query, header and body parameters reach the API', () => withApi(async (url, api) => {
  const tools = await createOpenApiTools({ spec: sampleSpec(url) });
  const q = await tools.callTool('echoQuery', { message: 'hi', tag: ['a', 'b'], 'x-trace': 'T' }, ctx());
  assert.deepEqual((q.data as { query: object }).query, { message: ['hi'], tag: ['a', 'b'] });
  assert.equal((q.data as { headers: Record<string, string> }).headers['x-trace'], 'T');
  const post = await tools.callTool('echoJson', { title: 'hello', tags: ['x'] }, ctx());
  assert.deepEqual((post.data as { json: unknown }).json, { title: 'hello', tags: ['x'] });
  assert.equal(api.requests.at(-1)!.headers['content-type'], 'application/json');
  assert.equal((await tools.callTool('get_text_value', { value: 'a b' }, ctx())).content, 'a b');
  const arr = await tools.callTool('putArray', { body: [1, 2] }, ctx());
  assert.deepEqual((arr.data as { json: unknown }).json, [1, 2]);
  const status = await tools.callTool('getStatus', { code: 404 }, ctx());
  assert.equal(status.isError, true);
  assert.match(status.content, /^HTTP 404/);
  const invalid = await tools.callTool('getStatus', { code: 99 }, ctx());
  assert.match(invalid.content, /Invalid arguments: args\.code: must be >= 100/);
  assert.match((await tools.callTool('echoJson', {}, ctx())).content, /args\.title: required/);
}));

test('include globs, risk by method and the unknown tool', () => withApi(async (url) => {
  const tools = await createOpenApiTools({ spec: sampleSpec(url), include: ['echo*', 'wipe*'], risk: { DELETE: 'exec', POST: 'exec' } });
  const specs = await tools.listTools(ctx());
  assert.deepEqual(specs.map((s) => [s.name, s.risk]), [['echoQuery', 'read'], ['echoJson', 'exec'], ['wipeEcho', 'exec']]);
  assert.equal((await tools.callTool('getStatus', { code: 200 }, ctx())).isError, true);
}));

test('auth: bearer from the caller credentials on every operation; none, nothing sent', () => withApi(async (url, api) => {
  const tools = await createOpenApiTools({ spec: sampleSpec(url), auth: { audience: 'orders-api' } });
  assert.equal((await tools.listTools(ctx()))[0]!.audience, 'orders-api');
  const refused = await tools.callTool('echoQuery', { message: 'x' }, ctx());
  assert.equal(refused.isError, true);
  assert.equal(api.requests.length, 0);
  const ok = await tools.callTool('echoQuery', { message: 'x' }, ctx({ credentials: { token: async () => 'tok-abc' } }));
  assert.equal(api.requests[0]!.headers.authorization, 'Bearer tok-abc');
  assert.equal(JSON.stringify(ok).includes('tok-abc'), false);
}));

test('static headers resolve ${env:X}; spec path and baseUrl come from the options', () => withApi(async (url, api) => {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-'));
  try {
    const spec = sampleSpec('http://spec.invalid');
    await writeFile(join(dir, 'api.json'), JSON.stringify(spec));
    const tools = await createOpenApiTools({ spec: 'api.json', baseUrl: '${env:API_URL}/', headers: { 'x-api-key': '${env:KEY}' } }, { cwd: dir, env: { API_URL: url, KEY: 'k-1' } });
    await tools.callTool('echoQuery', { message: 'x' }, ctx());
    assert.equal(api.requests[0]!.headers['x-api-key'], 'k-1');
    assert.equal(api.requests[0]!.path, '/echo');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}));

test('spec from a URL; a relative servers entry resolves against it', async () => {
  const doc = sampleSpec('/v1');
  await withApi(async (url, api) => {
    const tools = await createOpenApiTools({ spec: `${url}/openapi.json` });
    await tools.callTool('echoQuery', { message: 'x' }, ctx());
    assert.equal(api.requests.at(-1)!.path, '/v1/echo');
  }, { '/openapi.json': JSON.stringify(doc) });
});

test('spec problems are reported when the tools are built', async () => {
  await withApi(async (url) => {
    await assert.rejects(createOpenApiTools({ spec: `${url}/yaml` }), /not valid JSON \(YAML is not supported/);
    await assert.rejects(createOpenApiTools({ spec: `${url}/status/404` }), /cannot fetch OpenAPI spec .* HTTP 404/);
    await assert.rejects(createOpenApiTools({ spec: { swagger: '2.0', paths: {} } }), /not an OpenAPI 3 document/);
    await assert.rejects(createOpenApiTools({ spec: { openapi: '3.0.0', paths: {} } }), /absolute "baseUrl"/);
    await assert.rejects(createOpenApiTools({ spec: { openapi: '3.0.0', servers: [{ url: 'http://x' }], paths: { '/a': { get: { parameters: [{ $ref: '#/nope/x' }] } } } } }), /unresolved \$ref/);
    await assert.rejects(createOpenApiTools({ spec: 'nope.json' }, { cwd: tmpdir() }), /ENOENT/);
  }, { '/yaml': 'openapi: 3.0.0\n' });
});

test('a parameter declared in two locations is rejected', async () => {
  const spec = { openapi: '3.0.0', servers: [{ url: 'http://x' }], paths: { '/a/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true }, { name: 'id', in: 'query' }] } } } };
  await assert.rejects(createOpenApiTools({ spec } as OpenApiOptions), /declared in more than one location/);
});

test('descriptor metadata', () => {
  assert.deepEqual([adapter.port, adapter.direction, adapter.maps], ['ToolPort', 'outbound', { standard: 'OpenAPI 3' }]);
});
