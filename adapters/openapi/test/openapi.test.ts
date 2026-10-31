import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMappings, type CallContext } from '@agent-layers/core';
import { adapter, createOpenApiTools, type OpenApiOptions } from '../src/index.ts';
import { redirecting, startApi } from './mock.ts';
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
  const query = byName.echoQuery!.params as { properties: Record<string, any>; required: string[] };
  assert.deepEqual(Object.keys(query.properties), ['message', 'tag', 'x-trace']); // Authorization is handled by the transport
  assert.deepEqual(query.required, ['message']);
  assert.equal(query.properties.message.description, 'Text to echo');
  assert.equal(byName.echoQuery!.description, 'Echo the query');
  const note = byName.echoJson!.params as { properties: Record<string, any>; required: string[] };
  assert.deepEqual(Object.keys(note.properties), ['title', 'tags', 'parent', 'due']);
  assert.deepEqual(note.required, ['title']);
  assert.deepEqual(note.properties.due.type, ['string', 'null']); // 3.0 nullable
  assert.deepEqual(note.properties.parent, {}); // a reference back to itself is cut
  assert.deepEqual((byName.putArray!.params as { properties: Record<string, any> }).properties.body.type, 'array');
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
  assert.equal((await tools.callTool('get_text_value', { value: 'a b' }, ctx())).text, 'a b');
  const arr = await tools.callTool('putArray', { body: [1, 2] }, ctx());
  assert.deepEqual((arr.data as { json: unknown }).json, [1, 2]);
  const status = await tools.callTool('getStatus', { code: 404 }, ctx());
  assert.equal(status.ok, false);
  assert.match(status.text, /^HTTP 404/);
  const invalid = await tools.callTool('getStatus', { code: 99 }, ctx());
  assert.match(invalid.text, /Invalid arguments: args\.code: must be >= 100/);
  assert.match((await tools.callTool('echoJson', {}, ctx())).text, /args\.title: required/);
}));

test('include globs, risk by method and the unknown tool', () => withApi(async (url) => {
  const tools = await createOpenApiTools({ spec: sampleSpec(url), include: ['echo*', 'wipe*'], risk: { DELETE: 'exec', POST: 'exec' } });
  const specs = await tools.listTools(ctx());
  assert.deepEqual(specs.map((s) => [s.name, s.risk]), [['echoQuery', 'read'], ['echoJson', 'exec'], ['wipeEcho', 'exec']]);
  assert.equal((await tools.callTool('getStatus', { code: 200 }, ctx())).ok, false);
}));

test('auth: bearer from the caller credentials on every operation; none, nothing sent', () => withApi(async (url, api) => {
  const tools = await createOpenApiTools({ spec: sampleSpec(url), auth: { audience: 'orders-api' } });
  assert.equal((await tools.listTools(ctx()))[0]!.audience, 'orders-api');
  const refused = await tools.callTool('echoQuery', { message: 'x' }, ctx());
  assert.equal(refused.ok, false);
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

test('path parameters made only of dots are rejected and nothing is sent', () => withApi(async (url, api) => {
  const tools = await createOpenApiTools({ spec: sampleSpec(`${url}/v1`) });
  for (const bad of ['..', '.', '....']) {
    const out = await tools.callTool('get_text_value', { value: bad }, ctx());
    assert.equal(out.ok, false);
    assert.match(out.text, /Invalid path parameter\(s\): value/);
  }
  assert.equal(api.requests.length, 0);
  assert.equal((await tools.callTool('get_text_value', { value: 'a/../b' }, ctx())).ok, true);
  assert.equal(api.requests[0]!.path, '/v1/text/a%2F..%2Fb');
}));

test('a placeholder cannot reach the host through the server URL', async () => {
  await assert.rejects(createOpenApiTools({ spec: { openapi: '3.0.0', servers: [{ url: 'http://{host}' }], paths: { '/a': { get: {} } } } }), /not in the scheme or host|absolute/);
});

test('static header values and the token are redacted from text and data', () => withApi(async (url) => {
  const tools = await createOpenApiTools({ spec: sampleSpec(url), headers: { 'x-api-key': '${env:KEY}', 'x-team': 'blue-team' }, auth: { audience: 'a' } }, { env: { KEY: 'key-from-env-123' } });
  const out = await tools.callTool('echoQuery', { message: 'x', 'x-trace': 'trace-secret-9' }, ctx({ credentials: { token: async () => 'tok-xyz-789' } }));
  const everything = JSON.stringify(out);
  for (const secret of ['key-from-env-123', 'blue-team', 'trace-secret-9', 'tok-xyz-789']) assert.equal(everything.includes(secret), false, secret);
  assert.equal((out.data as { headers: Record<string, string> }).headers['x-api-key'], '[redacted]');
}));

test('a secret echoed as \\u escapes is masked in text and data, for successes and error bodies', () => withApi(async (url) => {
  const doc = { openapi: '3.0.3', servers: [{ url }], paths: { '/escaped': { get: { operationId: 'ok' } }, '/escaped-error': { get: { operationId: 'bad' } } } };
  const tools = await createOpenApiTools({ spec: doc, headers: { 'x-api-key': 'key-from-env-123' }, auth: { audience: 'a' } });
  const ok = await tools.callTool('ok', {}, ctx({ credentials: { token: async () => 'tok-xyz-789' } }));
  for (const secret of ['key-from-env-123', 'tok-xyz-789']) assert.equal(JSON.stringify(ok).includes(secret), false, secret);
  assert.deepEqual(ok.data, { key: '[redacted]', bearer: 'Bearer [redacted]' });
  const bad = await tools.callTool('bad', {}, ctx({ credentials: { token: async () => 'tok-xyz-789' } }));
  assert.equal(bad.ok, false);
  assert.equal(bad.text.includes('key-from-env-123') || bad.text.includes('tok-xyz-789'), false);
}));

test('in mapping rules shape the specs from the operation object; name and request stay the operation\'s', async () => {
  const spec = {
    openapi: '3.0.3', info: { title: 't', version: '1' }, servers: [{ url: 'http://127.0.0.1:9' }],
    paths: { '/items/{id}': { delete: { operationId: 'removeItem', 'x-owner': 'ops', 'x-risk': 'exec', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'gone' } } } } },
  };
  const mappings = createMappings('tools.items', { in: [
    { from: '/x-owner', to: '/attrs/owner' },
    { from: '/x-risk', to: '/risk' },
    { from: '/path', to: '/attrs/path' },
    { from: '/operationId', to: '/name', default: 'ignored' },
  ] });
  const [s] = await (await createOpenApiTools({ spec }, { mappings })).listTools({ runId: 'r', agent: 'a' });
  assert.equal(s!.name, 'removeItem');
  assert.equal(s!.risk, 'exec');
  assert.deepEqual(s!.attrs, { owner: 'ops', path: '/items/{id}' });
});

for (const status of [307, 308]) {
  test(`a ${status} redirect is refused: arguments and credentials never reach the other host`, async () => {
    const r = await redirecting(status);
    try {
      const tools = await createOpenApiTools({ spec: sampleSpec(r.url), headers: { 'x-api-key': 'static-key' } });
      const out = await tools.callTool('echoJson', { title: 'private' }, ctx());
      assert.equal(out.ok, false);
      assert.equal(out.text, `echoJson: redirects are not followed (HTTP ${status})`);
      assert.deepEqual(r.hits, []);
    } finally {
      await r.close();
    }
  });
}
