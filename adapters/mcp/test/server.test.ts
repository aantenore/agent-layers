// The stack's governed tools served as an MCP server through the gateway, called over streamable HTTP.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { compose, defineAdapter, PORT_VERSIONS, resolveProfile, type Stack, type StackConfig, type ToolPort } from '@agent-layers/core';
import { checkAdapter, inboundFetch } from '@agent-layers/conformance';
import { serveStack, type GatewayHandle } from '@agent-layers/gateway';
import { credentialAdapter, identityAdapter } from '@agent-layers/adapter-static-identity';
import { channelAdapter } from '../src/index.ts';

const seen: { tool: string; subject?: string; token?: string }[] = [];

const utilTools = defineAdapter<'ToolPort'>({
  layer: 'tool', port: 'ToolPort', name: 'test-tools', direction: 'outbound', maps: { technology: 'test double' },
  portVersion: PORT_VERSIONS.ToolPort, tiers: ['prototype'], optionsSchema: { type: 'object' },
  create: (): ToolPort => ({
    listTools: async () => [
      { name: 'echo', description: 'Echo the text', params: { type: 'object', properties: { text: { type: 'string' } } }, risk: 'read', audience: 'api' },
      { name: 'wipe', description: 'Delete everything', params: { type: 'object' }, risk: 'exec' },
    ],
    async callTool(name, args, ctx) {
      seen.push({ tool: name, ...(ctx.caller ? { subject: ctx.caller.id } : {}), ...(ctx.credentials ? { token: await ctx.credentials.token('api') } : {}) });
      return { ok: true, text: `echo: ${String(args.text)}`, data: { text: args.text } };
    },
  }),
});

const docs = defineAdapter<'KnowledgePort'>({
  layer: 'knowledge', port: 'KnowledgePort', name: 'test-docs', direction: 'outbound', maps: { technology: 'test double' },
  portVersion: PORT_VERSIONS.KnowledgePort, tiers: ['prototype'], optionsSchema: { type: 'object' },
  create: () => ({ async search() { return [{ id: 'p1', text: 'The ferry leaves at noon.', source: 'ferry.md' }]; } }),
});

let stack: Stack;
let gw: GatewayHandle;
const url = () => `${gw.url}/mcp`;
const headers = (token = 'dev-token', session?: string) => ({
  authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
  ...(session ? { 'mcp-session-id': session } : {}),
});
let rpcId = 0;
async function rpc(method: string, params: unknown, session: string, token = 'dev-token') {
  const res = await fetch(url(), { method: 'POST', headers: headers(token, session), body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  return { status: res.status, body: await res.json() as { result?: any; error?: { code: number; message: string } } };
}
async function initialize(token = 'dev-token'): Promise<string> {
  const res = await fetch(url(), {
    method: 'POST', headers: headers(token),
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { result: { protocolVersion: string; capabilities: { tools: unknown } } };
  assert.equal(body.result.protocolVersion, '2025-06-18');
  assert.ok(body.result.capabilities.tools);
  const id = res.headers.get('mcp-session-id');
  assert.ok(id);
  await fetch(url(), { method: 'POST', headers: headers(token, id), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  return id;
}

before(async () => {
  const config: StackConfig = {
    layers: {
      tools: { util: { adapter: 'test-tools' } },
      knowledge: { docs: { adapter: 'test-docs' } },
      identity: { adapter: 'static-identity', options: { tokens: { 'dev-token': { subject: 'dev-user' }, 'other-token': { subject: 'other-user' } } } },
      credentials: { adapter: 'static-identity', options: { tokens: { api: 'downstream-token' } } },
      channels: [{ adapter: 'mcp', options: { exclude: ['nothing__*'] } }],
    },
    policy: [{ effect: 'allow', risk: ['read'], when: { authenticated: true } }, { effect: 'deny' }],
  };
  stack = await compose(resolveProfile(config), { adapters: [utilTools, docs, identityAdapter, credentialAdapter, channelAdapter] });
  gw = await serveStack(stack, { port: 0 });
});

after(async () => {
  await gw.close();
  await stack.close();
});

test('callers authenticate at the gateway before any MCP message', async () => {
  const res = await fetch(url(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(res.status, 401);
});

test('initialize opens a session; requests need it, and only its caller can use it', async () => {
  const session = await initialize();
  assert.deepEqual((await rpc('ping', {}, session)).body.result, {});
  const missing = await fetch(url(), { method: 'POST', headers: headers(), body: '{"jsonrpc":"2.0","id":9,"method":"ping"}' });
  assert.equal(missing.status, 400);
  assert.equal((await rpc('ping', {}, session, 'other-token')).status, 404);
  assert.equal((await rpc('ping', {}, 'no-such-session')).status, 404);
  const unknown = await rpc('resources/list', {}, session);
  assert.equal(unknown.body.error!.code, -32601);
});

test('tools/list shows the governed tools and the knowledge sources, with hints from the risk', async () => {
  const session = await initialize();
  const { body } = await rpc('tools/list', {}, session);
  const tools = body.result.tools as { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean }; inputSchema: { type: string } }[];
  assert.deepEqual(tools.map((t) => t.name).sort(), ['knowledge__docs', 'util__echo', 'util__wipe']);
  const wipe = tools.find((t) => t.name === 'util__wipe')!;
  assert.deepEqual(wipe.annotations, { readOnlyHint: false, destructiveHint: true });
  assert.ok(tools.every((t) => t.inputSchema.type === 'object'));
});

test('tools/call goes through policy, credentials bound to the caller, and knowledge search', async () => {
  const session = await initialize();
  seen.length = 0;
  const ok = await rpc('tools/call', { name: 'util__echo', arguments: { text: 'hi' } }, session);
  assert.deepEqual(ok.body.result, { content: [{ type: 'text', text: 'echo: hi' }], isError: false, structuredContent: { text: 'hi' } });
  assert.deepEqual(seen, [{ tool: 'echo', subject: 'dev-user', token: 'downstream-token' }]);
  const denied = await rpc('tools/call', { name: 'util__wipe', arguments: {} }, session);
  assert.equal(denied.body.result.isError, true);
  assert.match(denied.body.result.content[0].text, /^Denied/);
  assert.equal(seen.length, 1, 'a denied tool never runs');
  const knowledge = await rpc('tools/call', { name: 'knowledge__docs', arguments: { query: 'ferry' } }, session);
  assert.match(knowledge.body.result.content[0].text, /noon/);
  const unknown = await rpc('tools/call', { name: 'util__nope', arguments: {} }, session);
  assert.equal(unknown.body.error!.code, -32602);
});

test('SSE responses for clients that accept only SSE; DELETE ends the session; GET is not offered', async () => {
  const session = await initialize();
  const res = await fetch(url(), { method: 'POST', headers: { ...headers('dev-token', session), accept: 'text/event-stream' }, body: '{"jsonrpc":"2.0","id":"s1","method":"ping"}' });
  assert.match(res.headers.get('content-type')!, /text\/event-stream/);
  assert.equal(await res.text(), 'event: message\ndata: {"jsonrpc":"2.0","id":"s1","result":{}}\n\n');
  assert.equal((await fetch(url(), { headers: headers('dev-token', session) })).status, 405);
  assert.equal((await fetch(url(), { method: 'DELETE', headers: headers('dev-token', session) })).status, 204);
  assert.equal((await rpc('ping', {}, session)).status, 404);
  const batch = await fetch(url(), { method: 'POST', headers: headers('dev-token', session), body: '[]' });
  assert.equal(batch.status, 400);
});

test('the inbound descriptor passes ChannelPort conformance', async () => {
  const report = await checkAdapter(channelAdapter, {
    fixtures: {
      async exerciseMount(mount: Parameters<typeof inboundFetch>[0]) {
        const res = await inboundFetch(mount, new Request('http://gateway.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) }));
        assert.ok(res.headers.get('mcp-session-id'));
      },
    },
  });
  assert.deepEqual(report.failures, []);
});

test('a foreign Origin is refused before the MCP server sees the request (DNS rebinding)', async () => {
  const res = await fetch(url(), { method: 'POST', headers: { ...headers(), origin: 'http://evil.test' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('mcp-session-id'), null);
});

// Protocol revisions: legacy handshake sessions and the modern stateless revision share the endpoint.
const MODERN = '2026-07-28';
const metaOf = (version: string = MODERN) => ({
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
});
type Reply = { status: number; headers: Headers; body: { result?: any; error?: { code: number; message: string; data?: any } } };
async function post(body: unknown, extra: Record<string, string> = {}, token = 'dev-token'): Promise<Reply> {
  const res = await fetch(url(), { method: 'POST', headers: { ...headers(token), ...extra }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, body: await res.json() as Reply['body'] };
}
/** A modern request with consistent envelope and headers; `hdr` replaces or (undefined) drops headers. */
function modern(method: string, params: Record<string, unknown> = {}, hdr: Record<string, string | undefined> = {}, version = MODERN, token = 'dev-token') {
  const extra: Record<string, string> = { 'mcp-protocol-version': version, 'mcp-method': method };
  const named = typeof params.name === 'string' ? params.name : undefined;
  if (named) extra['mcp-name'] = named;
  for (const [k, v] of Object.entries(hdr)) { if (v === undefined) delete extra[k]; else extra[k] = v; }
  return post({ jsonrpc: '2.0', id: ++rpcId, method, params: { ...params, _meta: metaOf(version) } }, extra, token);
}
const handshake = (protocolVersion: string, extra: Record<string, string> = {}) =>
  post({ jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '1' } } }, extra);

test('initialize never refuses a revision: it answers the asked one when served, else the latest legacy one', async () => {
  const unknown = await handshake('2099-01-01');
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.result.protocolVersion, '2025-11-25');
  assert.ok(unknown.headers.get('mcp-session-id'));
  assert.equal((await handshake('2025-06-18')).body.result.protocolVersion, '2025-06-18');
  assert.equal((await handshake('2024-11-05')).body.result.protocolVersion, '2024-11-05');
  // A modern revision proposed in a handshake selects legacy semantics at the latest legacy revision.
  assert.equal((await handshake(MODERN)).body.result.protocolVersion, '2025-11-25');
  const header = await handshake('2025-06-18', { 'mcp-protocol-version': MODERN });
  assert.equal(header.status, 200);
  assert.ok(header.headers.get('mcp-session-id'));
});

test('a session request with an unsupported revision header is refused', async () => {
  const session = await initialize();
  const res = await post({ jsonrpc: '2.0', id: ++rpcId, method: 'ping' }, { 'mcp-session-id': session, 'mcp-protocol-version': '2099-01-01' });
  assert.equal(res.status, 400);
  assert.equal((await post({ jsonrpc: '2.0', id: ++rpcId, method: 'ping' }, { 'mcp-session-id': session, 'mcp-protocol-version': '2025-11-25' })).status, 200);
});

test('modern server/discover lists the served revisions and names the server, without a session', async () => {
  const res = await modern('server/discover');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('mcp-session-id'), null);
  const r = res.body.result;
  assert.equal(r.resultType, 'complete');
  assert.deepEqual(r.supportedVersions, [MODERN, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
  assert.ok(r.capabilities.tools);
  assert.equal(r._meta['io.modelcontextprotocol/serverInfo'].name, 'agent-layers');
  assert.equal(typeof r.ttlMs, 'number');
  assert.equal(r.cacheScope, 'private');
});

test('modern tools/list and tools/call work without a session and run as the caller', async () => {
  const list = await modern('tools/list');
  assert.equal(list.status, 200);
  assert.equal(list.body.result.resultType, 'complete');
  assert.deepEqual((list.body.result.tools as { name: string }[]).map((t) => t.name).sort(), ['knowledge__docs', 'util__echo', 'util__wipe']);
  seen.length = 0;
  const ok = await modern('tools/call', { name: 'util__echo', arguments: { text: 'hi' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.result.resultType, 'complete');
  assert.equal(ok.body.result.content[0].text, 'echo: hi');
  assert.deepEqual(seen, [{ tool: 'echo', subject: 'dev-user', token: 'downstream-token' }]);
  // Governance applies as in a session.
  assert.equal((await modern('tools/call', { name: 'util__wipe', arguments: {} })).body.result.isError, true);
  // Mcp-Name may travel base64-wrapped.
  const b64 = `=?base64?${Buffer.from('util__echo', 'utf8').toString('base64')}?=`;
  assert.equal((await modern('tools/call', { name: 'util__echo', arguments: { text: 'x' } }, { 'mcp-name': b64 })).status, 200);
  // Anonymous callers never reach the endpoint.
  const anon = await fetch(url(), { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: metaOf() } }) });
  assert.equal(anon.status, 401);
});

test('a modern request for an unknown revision is answered with the served ones, never a generic error', async () => {
  const res = await modern('server/discover', {}, {}, '2099-01-01');
  assert.equal(res.status, 400);
  assert.equal(res.body.error!.code, -32022);
  assert.equal(res.body.error!.data.requested, '2099-01-01');
  assert.deepEqual(res.body.error!.data.supported, [MODERN, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
});

test('modern requests whose headers disagree with the request are refused with HeaderMismatch', async () => {
  const wrongVersion = await modern('tools/list', {}, { 'mcp-protocol-version': '2025-11-25' });
  assert.equal(wrongVersion.status, 400);
  assert.equal(wrongVersion.body.error!.code, -32020);
  const noVersion = await modern('tools/list', {}, { 'mcp-protocol-version': undefined });
  assert.equal(noVersion.body.error!.code, -32020);
  const noMethod = await modern('tools/list', {}, { 'mcp-method': undefined });
  assert.equal(noMethod.status, 400);
  assert.equal(noMethod.body.error!.code, -32020);
  assert.equal((await modern('tools/list', {}, { 'mcp-method': 'tools/call' })).body.error!.code, -32020);
  const noName = await modern('tools/call', { name: 'util__echo', arguments: {} }, { 'mcp-name': undefined });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.error!.code, -32020);
  assert.equal((await modern('tools/call', { name: 'util__echo', arguments: {} }, { 'mcp-name': 'util__wipe' })).body.error!.code, -32020);
});

test('modern requests: unknown methods are 404, a missing envelope is invalid params, notifications are accepted', async () => {
  const unknown = await modern('resources/list');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error!.code, -32601);
  const bare = await post({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' }, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' });
  assert.equal(bare.status, 400);
  assert.equal(bare.body.error!.code, -32602);
  const note = await fetch(url(), { method: 'POST', headers: { ...headers(), 'mcp-protocol-version': MODERN }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }) });
  assert.equal(note.status, 202);
});

test('the legacy session flow is unchanged next to the modern one', async () => {
  const session = await initialize();
  assert.deepEqual((await rpc('ping', {}, session)).body.result, {});
  const list = await rpc('tools/list', {}, session);
  assert.equal(list.body.result.resultType, undefined);
  assert.equal(list.body.result.tools.length, 3);
  assert.equal((await modern('tools/list')).status, 200);
});
