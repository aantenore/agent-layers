import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallContext } from '@agent-layers/core';
import { adapter, createHttpTools, type HttpToolsOptions } from '../src/index.ts';
import { startApi } from './mock.ts';

const ctx = (over: Partial<CallContext> = {}): CallContext => ({ runId: 'run-1', agent: 'agent-1', ...over });

async function withApi(fn: (url: string, api: Awaited<ReturnType<typeof startApi>>) => Promise<void>) {
  const api = await startApi();
  try { await fn(api.url, api); } finally { await api.close(); }
}

test('path arguments are URL-encoded, query arrays repeat, header arguments are sent', () => withApi(async (url, api) => {
  const tools = createHttpTools({
    tools: {
      text: { description: 'Text', method: 'GET', url: `${url}/text/{value}` },
      search: { description: 'Search', method: 'GET', url: `${url}/echo`, query: ['q', 'tag'], headerArgs: ['x-trace'], headers: { 'x-api-key': 'static-key' } },
    },
  });
  assert.equal((await tools.callTool('text', { value: 'a/b c' }, ctx())).content, 'a/b c');
  const out = await tools.callTool('search', { q: 'hi', tag: ['a', 'b'], 'x-trace': 't1' }, ctx());
  const echoed = out.data as { query: object; headers: Record<string, string> };
  assert.deepEqual(echoed.query, { q: ['hi'], tag: ['a', 'b'] });
  assert.equal(echoed.headers['x-trace'], 't1');
  assert.equal(echoed.headers['x-api-key'], '[redacted]'); // a static header value never comes back
  assert.equal(api.requests.at(-1)!.headers['x-api-key'], 'static-key');
  assert.equal(JSON.parse(out.content).method, 'GET');
}));

test('JSON body: the remaining arguments, or only bodyArg', () => withApi(async (url) => {
  const tools = createHttpTools({
    tools: {
      rest: { description: 'Rest', method: 'post', url: `${url}/echo/{id}`, query: ['dry'], body: 'json' },
      whole: { description: 'Whole', method: 'PUT', url: `${url}/echo`, body: 'json', bodyArg: 'payload' },
    },
  });
  const rest = await tools.callTool('rest', { id: 7, dry: true, title: 'hi' }, ctx());
  assert.deepEqual(rest.data, { method: 'POST', path: '/echo/7', query: { dry: ['true'] }, headers: { authorization: null, 'x-trace': null, 'x-api-key': null }, json: { title: 'hi' } });
  const whole = await tools.callTool('whole', { payload: [1, 2] }, ctx());
  assert.deepEqual((whole.data as { json: unknown }).json, [1, 2]);
}));

test('arguments are validated before anything is sent', () => withApi(async (url, api) => {
  const tools = createHttpTools({
    tools: {
      get: { description: 'Get', method: 'GET', url: `${url}/echo/{id}`, query: ['limit'], schema: { type: 'object', properties: { id: { type: 'string' }, limit: { type: 'integer' } }, required: ['id'], additionalProperties: false } },
      derived: { description: 'Derived', method: 'GET', url: `${url}/echo/{id}` },
    },
  });
  const wrong = await tools.callTool('get', { id: 'x', limit: 'many' }, ctx());
  assert.equal(wrong.isError, true);
  assert.match(wrong.content, /Invalid arguments: args\.limit/);
  assert.match((await tools.callTool('derived', {}, ctx())).content, /args\.id: required/);
  assert.match((await tools.callTool('derived', { id: 'a', other: 1 }, ctx())).content, /unknown property/);
  assert.equal(api.requests.length, 0);
  const specs = await tools.listTools(ctx());
  assert.deepEqual(specs.map((s) => [s.name, s.risk, s.layer]), [['get', 'read', 'tool'], ['derived', 'read', 'tool']]);
}));

test('risk defaults to read for GET and HEAD and write otherwise, and can be set', async () => {
  const tools = createHttpTools({
    tools: {
      a: { description: 'a', method: 'GET', url: 'http://x/a' }, b: { description: 'b', method: 'POST', url: 'http://x/b' },
      c: { description: 'c', method: 'DELETE', url: 'http://x/c', risk: 'exec' }, d: { description: 'd', method: 'HEAD', url: 'http://x/d' },
    },
  });
  assert.deepEqual((await tools.listTools(ctx())).map((s) => s.risk), ['read', 'write', 'exec', 'read']);
});

test('non-2xx answers are error results; binary, empty and large bodies are summarized', () => withApi(async (url) => {
  const tools = createHttpTools({
    tools: {
      status: { description: 's', method: 'GET', url: `${url}/status/{code}` },
      bytes: { description: 'b', method: 'GET', url: `${url}/bytes` },
      empty: { description: 'e', method: 'GET', url: `${url}/empty` },
      big: { description: 'g', method: 'GET', url: `${url}/big`, maxResultChars: 10 },
    },
  });
  const err = await tools.callTool('status', { code: 418 }, ctx());
  assert.equal(err.isError, true);
  assert.match(err.content, /^HTTP 418/);
  assert.match(err.content, /status 418/);
  assert.match((await tools.callTool('bytes', {}, ctx())).content, /^HTTP 200: 32 bytes of image\/png \(not shown\)$/);
  assert.equal((await tools.callTool('empty', {}, ctx())).content, 'HTTP 204 (no content)');
  assert.equal((await tools.callTool('big', {}, ctx())).content, 'xxxxxxxxxx\n[truncated: 100 chars in total]');
}));

test('auth: bearer token from the caller credentials; without credentials nothing is sent', () => withApi(async (url, api) => {
  const asked: unknown[] = [];
  const tools = createHttpTools({ tools: { me: { description: 'me', method: 'GET', url: `${url}/echo`, auth: { audience: 'tools-api', scopes: ['read'] } } } });
  assert.equal((await tools.listTools(ctx()))[0]!.audience, 'tools-api');
  const refused = await tools.callTool('me', {}, ctx());
  assert.equal(refused.isError, true);
  assert.match(refused.content, /needs credentials for audience "tools-api"/);
  const broken = await tools.callTool('me', {}, ctx({ credentials: { token: async () => { throw new Error('idp down'); } } }));
  assert.match(broken.content, /idp down/);
  assert.equal(api.requests.length, 0);
  const ok = await tools.callTool('me', {}, ctx({ credentials: { token: async (audience, opts) => { asked.push([audience, opts?.scopes]); return 'tok-123'; } } }));
  assert.equal(ok.isError, undefined);
  assert.equal(api.requests[0]!.headers.authorization, 'Bearer tok-123');
  assert.deepEqual(asked, [['tools-api', ['read']]]);
  // The echo API returns the Authorization header; the token must not come back.
  assert.equal(ok.content.includes('tok-123'), false);
  assert.equal((ok.data as { headers: { authorization: string } }).headers.authorization, 'Bearer [redacted]');
}));

test('a static Authorization header is redacted too, and ${env:X} resolves from the context env', () => withApi(async (url, api) => {
  const tools = createHttpTools(
    { tools: { me: { description: 'me', method: 'GET', url: '${env:API}/echo', headers: { Authorization: 'Bearer ${env:API_TOKEN}', 'x-api-key': '${env:KEY:-dev-key}' } } } },
    { env: { API: url, API_TOKEN: 'static-secret' } },
  );
  const out = await tools.callTool('me', {}, ctx());
  assert.equal(api.requests[0]!.headers.authorization, 'Bearer static-secret');
  assert.equal(api.requests[0]!.headers['x-api-key'], 'dev-key');
  assert.equal(out.content.includes('static-secret'), false);
}));

test('a missing environment variable fails when the tools are built', () => {
  assert.throws(() => createHttpTools({ tools: { t: { description: 't', method: 'GET', url: '${env:NOPE}/x' } } }, { env: {} }), /environment variable NOPE is not set/);
});

test('unknown tool is an error result; unreachable host and cancellation reject', async () => {
  const tools = createHttpTools({ tools: { t: { description: 't', method: 'GET', url: 'http://127.0.0.1:9/x', timeoutMs: 2000 } } });
  const unknown = await tools.callTool('nope', {}, ctx());
  assert.equal(unknown.isError, true);
  await assert.rejects(tools.callTool('t', {}, ctx()));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(tools.callTool('t', {}, ctx({ signal: ac.signal })), (err: Error) => err.name === 'AbortError');
});

test('definition errors are reported when the tools are built', () => {
  const build = (def: Record<string, unknown>) => () => createHttpTools({ tools: { t: { description: 't', method: 'GET', url: 'http://x/y', ...def } } as HttpToolsOptions['tools'] });
  assert.throws(build({ method: 'TRACE' }), /unsupported method/);
  assert.throws(build({ body: 'json' }), /cannot have a body/);
  assert.throws(build({ bodyArg: 'x' }), /bodyArg needs body/);
  assert.throws(build({ url: '/relative' }), /absolute/);
  assert.throws(() => createHttpTools({ tools: { 'bad name': { description: 'x', method: 'GET', url: 'http://x' } } }), /invalid tool name/);
  assert.equal(adapter.optionsSchema !== undefined, true);
});

test('path parameters made only of dots are rejected and nothing is sent', () => withApi(async (url, api) => {
  const tools = createHttpTools({ tools: { item: { description: 'Item', method: 'GET', url: `${url}/api/items/{id}` }, deep: { description: 'Deep', method: 'GET', url: `${url}/api/{a}/{b}` } } });
  for (const bad of ['..', '.', '...']) {
    const out = await tools.callTool('item', { id: bad }, ctx());
    assert.equal(out.isError, true);
    assert.match(out.content, /Invalid path parameter\(s\): id/);
  }
  assert.equal((await tools.callTool('deep', { a: 'x', b: '..' }, ctx())).isError, true);
  assert.equal(api.requests.length, 0);
  // Encoded traversal stays a single, harmless segment; dots inside a value are fine.
  assert.equal((await tools.callTool('item', { id: '%2e%2e' }, ctx())).isError, undefined);
  assert.equal(api.requests[0]!.path, '/api/items/%252e%252e');
  assert.equal((await tools.callTool('item', { id: 'a/../b' }, ctx())).isError, undefined);
  assert.equal(api.requests[1]!.path, '/api/items/a%2F..%2Fb');
  assert.equal((await tools.callTool('item', { id: 'v1.2' }, ctx())).isError, undefined);
  assert.equal(api.requests[2]!.path, '/api/items/v1.2');
}));

test('placeholders are not allowed in the scheme or host', () => {
  for (const url of ['http://{host}/x', 'http://h{x}/x', 'http://h:{port}/x']) {
    assert.throws(() => createHttpTools({ tools: { t: { description: 't', method: 'GET', url } } }), /not in the scheme or host/);
  }
});

test('every static header value, header argument value and the token are redacted from content and data', () => withApi(async (url) => {
  const tools = createHttpTools({
    tools: {
      me: {
        description: 'me', method: 'GET', url: `${url}/echo`, headerArgs: ['x-trace'], auth: { audience: 'a' },
        headers: { 'x-api-key': 'key-from-env-123', 'x-team': 'blue-team', 'x-id': 'ab' },
      },
    },
  });
  const out = await tools.callTool('me', { 'x-trace': 'trace-secret-9' }, ctx({ credentials: { token: async () => 'tok-xyz-789' } }));
  const everything = JSON.stringify(out);
  for (const secret of ['key-from-env-123', 'blue-team', 'trace-secret-9', 'tok-xyz-789']) assert.equal(everything.includes(secret), false, secret);
  const headers = (out.data as { headers: Record<string, string> }).headers;
  assert.deepEqual([headers['x-api-key'], headers['x-trace'], headers.authorization], ['[redacted]', '[redacted]', 'Bearer [redacted]']);
}));

test('a secret that a server echoes JSON-escaped is redacted too', () => withApi(async (url) => {
  const tools = createHttpTools({ tools: { me: { description: 'me', method: 'GET', url: `${url}/echo`, headers: { 'x-api-key': 'pa"ss\\word' } } } });
  const out = await tools.callTool('me', {}, ctx());
  assert.equal(out.content.includes('pa\\"ss'), false);
  assert.equal((out.data as { headers: Record<string, string> }).headers['x-api-key'], '[redacted]');
}));
