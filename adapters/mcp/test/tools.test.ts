import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createMappings, noMappings, type BoundCredentials, type CallContext } from '@agent-layers/core';
import { createMcpTools, McpHttpError, McpSession, toolAdapter, TOOL_RULES } from '../src/index.ts';
import { startMcpMock } from './mock.ts';

const ctx = (over: Partial<CallContext> = {}): CallContext => ({ runId: 'run-1', agent: 'agent-1', ...over });
const stdioServer = fileURLToPath(new URL('./stdio-server.ts', import.meta.url));
const stdio = { command: process.execPath, args: [stdioServer], timeoutMs: 10_000 };

test('lists tools over HTTP across pages, with risk from annotations, readOnly globs and a forced value', async () => {
  const mock = await startMcpMock();
  const tools = createMcpTools({ url: mock.url, readOnly: ['lookup_*'] });
  try {
    const specs = await tools.listTools(ctx());
    assert.deepEqual(specs.map((s) => s.name), ['echo', 'remove', 'wipe', 'lookup_docs', 'fail', 'who_am_i', 'headers', 'fixed', 'search']);
    const risk = Object.fromEntries(specs.map((s) => [s.name, s.risk]));
    assert.deepEqual(risk, { echo: 'read', remove: 'write', wipe: 'exec', lookup_docs: 'read', fail: 'exec', who_am_i: 'exec', headers: 'exec', fixed: 'exec', search: 'exec' });
    assert.equal(specs[0]!.params.type, 'object');
    assert.deepEqual(specs[0]!.ext, { 'mcp.annotations': { readOnlyHint: true } });
    assert.deepEqual(specs.find((s) => s.name === 'who_am_i')!.ext, { 'mcp.name': 'who/am i' });
  } finally {
    await tools.close?.();
    await mock.close();
  }
});

test('include, exclude and forced risk', async () => {
  const mock = await startMcpMock();
  const tools = createMcpTools({ url: mock.url, include: ['echo', 'w*', 'fail'], exclude: ['wipe'], risk: 'read' });
  try {
    const specs = await tools.listTools(ctx());
    assert.deepEqual(specs.map((s) => [s.name, s.risk]), [['echo', 'read'], ['fail', 'read'], ['who_am_i', 'read']]);
  } finally {
    await tools.close?.();
    await mock.close();
  }
});

test('risk comes from the in mapping rules: replaceable, extensible, or cleared (missing means exec)', async () => {
  const mock = await startMcpMock();
  const risks = async (mappings: ReturnType<typeof createMappings>) => {
    const tools = createMcpTools({ url: mock.url }, { mappings });
    try {
      return Object.fromEntries((await tools.listTools(ctx())).map((s) => [s.name, s.risk]));
    } finally {
      await tools.close?.();
    }
  };
  try {
    const custom = await risks(createMappings('tools.x', { in: [...TOOL_RULES, { from: '/name', to: '/attrs/origin' }, { from: '/description', to: '/risk', map: { 'Looks things up': 'read' } }] }));
    assert.equal(custom.lookup_docs, 'read');
    assert.equal(custom.echo, 'read');
    const cleared = await risks(noMappings('tools.x'));
    assert.equal(cleared.echo, undefined);
  } finally {
    await mock.close();
  }
});

test('calls tools over HTTP: text, tool errors, structured content, original names', async () => {
  const mock = await startMcpMock();
  const tools = createMcpTools({ url: mock.url });
  try {
    assert.deepEqual(await tools.callTool('echo', { text: 'hi' }, ctx()), { ok: true, text: 'echo: hi' });
    assert.deepEqual(await tools.callTool('fail', {}, ctx()), { ok: false, text: 'it broke' });
    assert.deepEqual(await tools.callTool('lookup_docs', {}, ctx()), { ok: true, text: '{"found":1}', data: { found: 1 } });
    assert.match((await tools.callTool('who_am_i', {}, ctx())).text, /authorization=none/);
    const unknown = await tools.callTool('nope', {}, ctx());
    assert.equal(unknown.ok, false);
    assert.equal(mock.requests.filter((r) => r.rpc === 'initialize').length, 1);
  } finally {
    await tools.close?.();
    await mock.close();
  }
});

test('reads SSE responses split across chunks and keeps the session id', async () => {
  const mock = await startMcpMock({ sse: true });
  const tools = createMcpTools({ url: mock.url, headers: { 'x-team': 'blue' } });
  try {
    assert.equal((await tools.callTool('echo', { text: 'sse' }, ctx())).text, 'echo: sse');
    const calls = mock.requests.filter((r) => r.rpc === 'tools/call');
    assert.equal(calls[0]!.headers['mcp-session-id'], 's1');
    assert.equal(calls[0]!.headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(calls[0]!.headers['x-team'], 'blue');
    await tools.close?.();
    assert.equal(mock.requests.at(-1)!.method, 'DELETE');
  } finally {
    await mock.close();
  }
});

test('reconnects once when the HTTP session has expired', async () => {
  const mock = await startMcpMock();
  const tools = createMcpTools({ url: mock.url, toolsTtlMs: 0 });
  try {
    await tools.callTool('echo', { text: 'a' }, ctx());
    mock.expireSession();
    assert.equal((await tools.callTool('echo', { text: 'b' }, ctx())).text, 'echo: b');
    assert.equal(mock.requests.filter((r) => r.rpc === 'initialize').length, 2);
  } finally {
    await tools.close?.();
    await mock.close();
  }
});

test('auth: per-call bearer from ctx.credentials, never sent without them, token redacted from results', async () => {
  const mock = await startMcpMock({ requireAuth: 'Bearer connect-token' });
  const asked: unknown[] = [];
  const credentials = (token: string): BoundCredentials => ({ token: async (audience, opts) => { asked.push([audience, opts?.scopes]); return token; } });
  const tools = createMcpTools({ url: mock.url, auth: { audience: 'mcp-api', scopes: ['read'] } }, { credentials: credentials('connect-token') });
  try {
    const specs = await tools.listTools(ctx());
    assert.equal(specs[0]!.audience, 'mcp-api');
    // A call without credentials is not sent at all.
    const before = mock.requests.length;
    const refused = await tools.callTool('echo', { text: 'x' }, ctx());
    assert.equal(refused.ok, false);
    assert.match(refused.text, /needs credentials for audience "mcp-api"/);
    assert.equal(mock.requests.length, before);
    // The call token replaces the connection token; the server rejects it, which rejects the call.
    await assert.rejects(tools.callTool('echo', { text: 'x' }, ctx({ credentials: credentials('other-token') })), /MCP HTTP 401/);
    assert.deepEqual(asked.at(-1), ['mcp-api', ['read']]);
    // With the accepted token the call goes through and an echoed token is redacted.
    const ok = await tools.callTool('who_am_i', {}, ctx({ credentials: credentials('connect-token') }));
    assert.equal(ok.text, 'authorization=Bearer [redacted]');
    assert.equal(JSON.stringify(ok).includes('connect-token'), false);
    const last = mock.requests.at(-1)!;
    assert.equal(last.headers.authorization, 'Bearer connect-token');
  } finally {
    await tools.close?.();
    await mock.close();
  }
});

test('auth: a failing credential provider is a result and nothing is sent', async () => {
  const mock = await startMcpMock();
  const tools = createMcpTools({ url: mock.url, auth: { audience: 'a' } });
  try {
    await tools.listTools(ctx());
    const before = mock.requests.length;
    const out = await tools.callTool('echo', { text: 'x' }, ctx({ credentials: { token: async () => { throw new Error('idp down'); } } }));
    assert.equal(out.ok, false);
    assert.match(out.text, /idp down/);
    assert.equal(mock.requests.length, before);
  } finally {
    await tools.close?.();
    await mock.close();
  }
});

test('an unreachable server rejects', async () => {
  const tools = createMcpTools({ url: 'http://127.0.0.1:9/mcp', timeoutMs: 2000 });
  await assert.rejects(tools.listTools(ctx()));
});

test('a cancelled call rejects', async () => {
  const mock = await startMcpMock();
  const tools = createMcpTools({ url: mock.url });
  try {
    await tools.listTools(ctx());
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(tools.callTool('echo', { text: 'x' }, ctx({ signal: ac.signal })), (err: Error) => err.name === 'AbortError');
  } finally {
    await tools.close?.();
    await mock.close();
  }
});

test('stdio: lists and calls tools, ignores non-protocol output, and closes the process', async () => {
  const tools = createMcpTools(stdio);
  try {
    const specs = await tools.listTools(ctx());
    assert.equal(specs.length, 9);
    assert.equal((await tools.callTool('echo', { text: 'pipe' }, ctx())).text, 'echo: pipe');
    assert.equal((await tools.callTool('fail', {}, ctx())).ok, false);
  } finally {
    await tools.close?.();
  }
});

test('stdio: reconnects after the server exits', async () => {
  const session = new McpSession(stdio);
  try {
    await assert.rejects(session.run((c) => c.callTool('crash', {})), /exited with code 3/);
    const tools = await session.run((c) => c.listTools());
    assert.equal(tools.length, 9);
  } finally {
    await session.close();
  }
});

test('stdio: a missing command rejects with a clear message', async () => {
  const tools = createMcpTools({ command: 'agent-layers-no-such-command', timeoutMs: 3000 });
  await assert.rejects(tools.listTools(ctx()), /failed to start/);
});

test('descriptor: needs exactly one transport, and auth needs HTTP', async () => {
  const create = (options: unknown) => toolAdapter.create(options as never, { name: 'x', env: {}, cwd: '.', telemetry: undefined as never, mappings: noMappings() });
  assert.throws(() => create({}), /exactly one of/);
  assert.throws(() => create({ command: 'a', url: 'http://x' }), /exactly one of/);
  assert.throws(() => create({ command: 'a', auth: { audience: 'x' } }), /needs the streamable HTTP/);
});

test('${env:X} in url and headers resolves from the context env', async () => {
  const mock = await startMcpMock();
  const tools = createMcpTools({ url: '${env:MCP_URL}', headers: { authorization: 'Bearer ${env:MCP_TOKEN:-dev}' } }, { env: { MCP_URL: mock.url } });
  try {
    await tools.listTools(ctx());
    assert.equal(mock.requests[0]!.headers.authorization, 'Bearer dev');
  } finally {
    await tools.close?.();
    await mock.close();
  }
});

test('the token and static header secrets are redacted from structured content as well as text', async () => {
  const mock = await startMcpMock();
  const tools = createMcpTools({ url: mock.url, auth: { audience: 'a' }, headers: { 'x-api-key': 'key-from-env-123' } });
  try {
    const out = await tools.callTool('headers', {}, ctx({ credentials: { token: async () => 'tok-xyz-789' } }));
    assert.deepEqual(out.data, { authorization: 'Bearer [redacted]', apiKey: '[redacted]' });
    const everything = JSON.stringify(out);
    for (const secret of ['tok-xyz-789', 'key-from-env-123']) assert.equal(everything.includes(secret), false, secret);
  } finally {
    await tools.close?.();
    await mock.close();
  }
});

test('static header secrets are redacted even without a per-call token', async () => {
  const mock = await startMcpMock();
  const tools = createMcpTools({ url: mock.url, headers: { 'x-api-key': 'key-from-env-123' } });
  try {
    const out = await tools.callTool('headers', {}, ctx());
    assert.deepEqual(out.data, { authorization: null, apiKey: '[redacted]' });
    assert.equal(JSON.stringify(out).includes('key-from-env-123'), false);
  } finally {
    await tools.close?.();
    await mock.close();
  }
});

test('structured content that cannot be redacted into valid JSON is dropped, with a note', async () => {
  const mock = await startMcpMock();
  const tools = createMcpTools({ url: mock.url, auth: { audience: 'a' } });
  try {
    // The structured result is {"k":"v"}; a token that is a slice of that text breaks it when masked.
    const out = await tools.callTool('fixed', {}, ctx({ credentials: { token: async () => 'k":"v' } }));
    assert.equal(out.data, undefined);
    assert.match(out.text, /structured content dropped/);
    assert.equal(out.text.includes('k":"v'), false);
  } finally {
    await tools.close?.();
    await mock.close();
  }
});

test('every error leaving callTool carries a masked message: HTTP error bodies and JSON-RPC errors that echo credentials', async () => {
  for (const echoErrors of ['http', 'rpc', 'long'] as const) {
    const mock = await startMcpMock({ echoErrors });
    const tools = createMcpTools({ url: mock.url, auth: { audience: 'a' }, headers: { 'x-api-key': 'key-from-env-123' } });
    try {
      const credentials = { token: async () => 'tok-xyz-789' };
      const settled = await tools.callTool('echo', { text: 'x' }, ctx({ credentials })).then((out) => ({ out }), (err: Error) => ({ err }));
      const text = 'err' in settled ? `${settled.err.message}\n${settled.err.stack}` : settled.out.text;
      assert.equal(/tok-|key-from/.test(text), false, echoErrors); // no fragment either, also across the 300-character cut
      assert.match(text, /\[redacted\]/, echoErrors);
      if (echoErrors !== 'rpc') assert.ok('err' in settled && settled.err instanceof McpHttpError && settled.err.status === 500);
      else assert.ok('out' in settled && settled.out.ok === false);
    } finally {
      await tools.close?.();
      await mock.close();
    }
  }
});

test('non-text content goes to ext["mcp.content"], masked; text items only make the text', async () => {
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (!raw) { res.writeHead(204).end(); return; }
    const msg = JSON.parse(raw) as { id?: number; method: string };
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    const result = msg.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 't', version: '1' } }
      : msg.method === 'tools/list'
        ? { tools: [{ name: 'shot', inputSchema: { type: 'object' } }, { name: 'only_image', inputSchema: { type: 'object' } }] }
        : (msg as { params?: { name?: string } }).params?.name === 'shot'
          ? { content: [{ type: 'text', text: 'a picture' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'resource', resource: { uri: 'file:///x', text: `key ${req.headers['x-api-key']}` } }] }
          : { content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const tools = createMcpTools({ url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/mcp`, headers: { 'x-api-key': 'key-from-env-123' } });
  try {
    const out = await tools.callTool('shot', {}, ctx());
    assert.equal(out.ok, true);
    assert.equal(out.text, 'a picture');
    assert.deepEqual(out.ext, { 'mcp.content': [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'resource', resource: { uri: 'file:///x', text: 'key [redacted]' } }] });
    assert.equal((await tools.callTool('only_image', {}, ctx())).text, '[image]');
  } finally {
    await tools.close?.();
    server.close();
  }
});

test('the governed spec keeps annotations and _meta in ext', async () => {
  const mock = await startMcpMock();
  const tools = createMcpTools({ url: mock.url });
  try {
    const specs = await tools.listTools(ctx());
    assert.deepEqual(specs.find((s) => s.name === 'remove')!.ext, { 'mcp.annotations': { destructiveHint: false } });
    assert.equal(specs.find((s) => s.name === 'wipe')!.ext, undefined);
  } finally {
    await tools.close?.();
    await mock.close();
  }
});
