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
    listTools: async () => [{ name: 'wait', description: 'Waits until cancelled', inputSchema: { type: 'object' }, risk: 'read' }],
    callTool: (_name, _args, ctx) => new Promise((resolve) => {
      started();
      ctx.signal?.addEventListener('abort', () => { aborted++; resolve({ content: 'cancelled', isError: true }); }, { once: true });
    }),
  }),
});

let stack: Stack;
let gw: GatewayHandle;
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
      identity: { adapter: 'static-identity', options: { tokens: { a: { subject: 'alice' }, b: { subject: 'bob' }, c: { subject: 'carol' } } } },
      channels: [{ adapter: 'mcp', options: { maxSessions: 2, maxSessionsPerCaller: 1 } }],
    },
    policy: [{ effect: 'allow', when: { authenticated: true } }],
  }), { adapters: [slowTools, identityAdapter, channelAdapter] });
  gw = await serveStack(stack, { port: 0 });
});

after(async () => {
  await gw.close();
  await stack.close();
});

test('a caller over its own cap replaces its oldest session, aborting what runs in it', async () => {
  const first = await open('a');
  assert.equal(first.status, 200);
  const running = new Promise<void>((r) => { started = r; });
  const call = post('a', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slow__wait', arguments: {} } }, first.id!);
  await running;
  const second = await open('a');
  assert.equal(second.status, 200);
  const out = await (await call).json() as { result: { isError: boolean } };
  assert.equal(out.result.isError, true);
  assert.equal(aborted, 1, 'the call in the evicted session was aborted');
  assert.equal(await ping('a', first.id!), 404);
  assert.equal(await ping('a', second.id!), 200);
});

test('the global cap refuses new sessions (429) instead of evicting other callers; sessions stay bound to their caller', async () => {
  const bob = await open('b');
  assert.equal(bob.status, 200);
  const carol = await open('c');
  assert.equal(carol.status, 429);
  assert.equal(carol.id, null);
  assert.equal(await ping('b', bob.id!), 200);
  assert.equal(await ping('a', bob.id!), 404, 'another caller presenting the id gets 404');
  const wrongType = await fetch(`${gw.url}/mcp`, { method: 'POST', headers: { ...headers('b', bob.id!), 'content-type': 'text/plain' }, body: '{"jsonrpc":"2.0","id":4,"method":"ping"}' });
  assert.equal(wrongType.status, 415);
});
