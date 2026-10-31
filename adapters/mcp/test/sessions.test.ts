// Session limits of the MCP server: no caller can push another caller's sessions out.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { compose, defineAdapter, PORT_VERSIONS, resolveProfile, type Stack, type ToolPort } from '@agent-layers/core';
import { serveStack, type GatewayHandle } from '@agent-layers/gateway';
import { identityAdapter } from '@agent-layers/adapter-static-identity';
import { channelAdapter } from '../src/index.ts';

let aborted = 0;
let started: () => void = () => {};
const slowTools = defineAdapter<'ToolPort'>({
  layer: 'tool', port: 'ToolPort', name: 'slow-tools', direction: 'outbound', maps: { technology: 'test double' },
  portVersion: PORT_VERSIONS.ToolPort, tiers: ['prototype'], optionsSchema: { type: 'object' },
  create: (): ToolPort => ({
    listTools: async () => [{ name: 'wait', description: 'Waits until cancelled', params: { type: 'object' }, risk: 'read' }],
    callTool: (_name, _args, ctx) => new Promise((resolve) => {
      started();
      ctx.signal?.addEventListener('abort', () => { aborted++; resolve({ ok: false, text: 'cancelled' }); }, { once: true });
    }),
  }),
});

let stack: Stack;
let gw: GatewayHandle;
let anon: GatewayHandle;
const headers = (token: string, session?: string) => ({
  authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', ...(session ? { 'mcp-session-id': session } : {}),
});
const post = (token: string, body: unknown, session?: string) => fetch(`${gw.url}/mcp`, { method: 'POST', headers: headers(token, session), body: JSON.stringify(body) });
async function open(token: string): Promise<{ status: number; id: string | null }> {
  const res = await post(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  await res.body?.cancel();
  return { status: res.status, id: res.headers.get('mcp-session-id') };
}
const ping = async (token: string, session: string) => (await post(token, { jsonrpc: '2.0', id: 2, method: 'ping' }, session)).status;

before(async () => {
  stack = await compose(resolveProfile({
    layers: {
      tools: { slow: { adapter: 'slow-tools' } },
      identity: { adapter: 'static-identity', options: { tokens: Object.fromEntries('abcdefgh'.split('').map((t) => [t, { subject: `user-${t}` }])) } },
      channels: [{ adapter: 'mcp', options: { maxSessions: 8, maxSessionsPerCaller: 2 } }],
    },
    policy: [{ effect: 'allow', when: { authenticated: true } }],
  }), { adapters: [slowTools, identityAdapter, channelAdapter] });
  gw = await serveStack(stack, { port: 0 });
  anon = await serveStack(stack, { port: 0, anonymous: true });
});

after(async () => {
  await gw.close();
  await anon.close();
  await stack.close();
});

test('a caller over its own cap replaces its oldest session, aborting what runs in it', async () => {
  const first = await open('a');
  const second = await open('a');
  assert.equal(second.status, 200);
  const running = new Promise<void>((r) => { started = r; });
  const call = post('a', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slow__wait', arguments: {} } }, first.id!);
  await running;
  assert.equal(await ping('a', second.id!), 200, 'second is now the most recently used');
  const third = await open('a');
  assert.equal(third.status, 200);
  const out = await (await call).json() as { result: { isError: boolean } };
  assert.equal(out.result.isError, true);
  assert.equal(aborted, 1, 'the call in the evicted session was aborted');
  assert.equal(await ping('a', first.id!), 404);
  assert.equal(await ping('a', second.id!), 200);
  assert.equal(await ping('a', third.id!), 200);
});

test('a full server evicts the least recently used session of the caller holding the most; ids stay bound to their caller', async () => {
  // a holds 2 sessions from the previous test; b..g one each: 8 in total.
  const others = [];
  for (const t of 'bcdefg') others.push(await open(t));
  assert.ok(others.every((o) => o.status === 200));
  const h = await open('h');
  assert.equal(h.status, 200, 'never a lockout: room is made');
  for (const [i, t] of [...'bcdefg'].entries()) assert.equal(await ping(t, others[i]!.id!), 200, `${t} keeps its session`);
  assert.equal(await ping('a', others[0]!.id!), 404, 'another caller presenting the id gets 404');
  const wrongType = await fetch(`${gw.url}/mcp`, { method: 'POST', headers: { ...headers('b', others[0]!.id!), 'content-type': 'text/plain' }, body: '{"jsonrpc":"2.0","id":4,"method":"ping"}' });
  assert.equal(wrongType.status, 415);
});

test('anonymous sessions are each their own owner and are never evicted for a new one', async () => {
  const openAnon = async () => {
    const res = await fetch(`${anon.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    await res.body?.cancel();
    return { status: res.status, id: res.headers.get('mcp-session-id') };
  };
  const pingAnon = async (id: string, auth?: string) => (await fetch(`${anon.url}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'mcp-session-id': id, ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: '{"jsonrpc":"2.0","id":2,"method":"ping"}',
  })).status;
  const one = await openAnon();
  const two = await openAnon();
  assert.equal((await openAnon()).status, 429, 'the anonymous pool is full: no anonymous session is evicted');
  assert.equal(await pingAnon(one.id!), 200);
  assert.equal(await pingAnon(two.id!), 200);
  assert.equal(await pingAnon(one.id!, 'a'), 404, 'an authenticated caller cannot use an anonymous session');
});

test('maxSessionsPerCaller must stay well below maxSessions', async () => {
  const { createMcpServerChannel } = await import('../src/index.ts');
  assert.throws(() => createMcpServerChannel({ maxSessions: 4, maxSessionsPerCaller: 2 }), /a quarter of maxSessions/);
});
