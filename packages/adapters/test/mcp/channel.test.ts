// The inbound MCP server on a mount, without a gateway: language shapes in, MCP wire out.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inboundFetch } from '@agent-layers/conformance';
import type { CallContext, ChannelHost, InboundContext, ToolPort } from '@agent-layers/core';
import { BOUNDS_META, createMcpServerChannel } from '../../src/mcp/index.ts';

const calls: CallContext[] = [];
const tools: ToolPort = {
  listTools: async () => [
    { name: 'look', description: 'Read', params: { type: 'object', properties: { q: { type: 'string' } } }, risk: 'read' },
    { name: 'audit', description: 'Added risk', params: { type: 'object' }, risk: 'sensitive-read' },
    { name: 'odd', description: 'Unknown risk', params: { type: 'object' }, risk: 'mystery' },
    { name: 'plain', description: 'No risk', params: { type: 'object' } },
  ],
  async callTool(name, args, ctx) {
    calls.push(ctx);
    return name === 'look' ? { ok: true, text: `found ${String(args.q)}`, data: { q: args.q }, ext: { 'sdk.outcome': 'ok' } } : { ok: false, text: 'Denied' };
  },
};
const host: ChannelHost = { agents: () => [], run: async () => { throw new Error('unused'); }, tools: () => tools };

async function rpc(mount: Awaited<ReturnType<NonNullable<ReturnType<typeof createMcpServerChannel>['mount']>>>, body: object, caller = { id: 'u-1', kind: 'user' as const, roles: [], scopes: [], credential: 'secret' }, session?: string) {
  const res = await inboundFetch(mount, new Request('http://gw.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(body),
  }), { caller });
  return { res, body: await res.json() as any };
}

test('tools/list serves params as inputSchema and risk as hints; tools/call maps ok/text/data and passes the caller', async () => {
  const like = (risk: string) => (risk === 'sensitive-read' ? 'read' : ['read', 'write', 'exec'].includes(risk) ? risk : 'exec');
  const mount = await createMcpServerChannel({}, 'mcp', like).mount!(host);
  const init = await rpc(mount, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const session = init.res.headers.get('mcp-session-id')!;
  const list = await rpc(mount, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, undefined, session);
  const byName = Object.fromEntries((list.body.result.tools as any[]).map((t) => [t.name, t]));
  assert.deepEqual(byName.look.inputSchema, { type: 'object', properties: { q: { type: 'string' } } });
  assert.deepEqual(byName.look.annotations, { readOnlyHint: true, destructiveHint: false });
  assert.deepEqual(byName.audit.annotations, { readOnlyHint: true, destructiveHint: false });
  assert.deepEqual(byName.odd.annotations, { readOnlyHint: false, destructiveHint: true });
  assert.deepEqual(byName.plain.annotations, { readOnlyHint: false, destructiveHint: true });
  const ok = await rpc(mount, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'look', arguments: { q: 'x' } } }, undefined, session);
  assert.deepEqual(ok.body.result, { content: [{ type: 'text', text: 'found x' }], isError: false, structuredContent: { q: 'x' } });
  const denied = await rpc(mount, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'audit', arguments: {} } }, undefined, session);
  assert.deepEqual(denied.body.result, { content: [{ type: 'text', text: 'Denied' }], isError: true });
  assert.equal(calls.at(-1)!.caller?.id, 'u-1');
  // Another caller cannot use the session.
  const other = await rpc(mount, { jsonrpc: '2.0', id: 5, method: 'tools/list' }, { id: 'u-2', kind: 'user', roles: [], scopes: [], credential: 'x' }, session);
  assert.equal(other.res.status, 404);
  await mount.close?.();
});

test('tools/call reads params._meta bounds, combines them with the gateway delegation, and refuses invalid ones', async () => {
  const mount = await createMcpServerChannel().mount!(host);
  const call = (meta: unknown, ctx: Partial<InboundContext> = {}) => inboundFetch(mount, new Request('http://gw.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'look' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'look', arguments: { q: 'x' }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', ...(meta === undefined ? {} : { [BOUNDS_META]: meta }) } } }),
  }), ctx).then((r) => r.json() as Promise<any>);
  const sent = { remainingMs: 30_000, hops: 1, maxHops: 3, tokens: 500, costUsd: 0.2, rootRunId: 'run-a', parentRunId: 'run-b', unknown: 'dropped' };
  const { unknown: _, ...clean } = sent;

  assert.equal(BOUNDS_META, 'agent-layers/bounds');
  assert.equal((await call(sent)).result.isError, false);
  assert.deepEqual(calls.at(-1)!.delegation, clean);

  const gateway = { remainingMs: 10_000, hops: 2, maxHops: 5 };
  await call(sent, { delegation: gateway });
  assert.deepEqual(calls.at(-1)!.delegation, { remainingMs: 10_000, hops: 2, maxHops: 3, tokens: 500, costUsd: 0.2, rootRunId: 'run-a', parentRunId: 'run-b' });

  await call(undefined, { delegation: gateway });
  assert.deepEqual(calls.at(-1)!.delegation, gateway, 'the gateway delegation alone is passed on');
  await call(undefined);
  assert.equal(calls.at(-1)!.delegation, undefined);

  const before = calls.length;
  for (const bad of [{ remainingMs: -1, hops: 0, maxHops: 1 }, { remainingMs: 1, hops: 0 }, 'soon', [1], { remainingMs: 1.5, hops: 0, maxHops: 1 }]) {
    const out = await call(bad);
    assert.equal(out.error?.code, -32602, JSON.stringify(bad));
    assert.match(out.error.message, /agent-layers\/bounds/);
  }
  assert.equal(calls.length, before, 'an invalid carrier runs nothing');
  await mount.close?.();
});
