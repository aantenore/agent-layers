// The inbound MCP server on a mount, without a gateway: language shapes in, MCP wire out.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inboundFetch } from '@agent-layers/conformance';
import type { CallContext, ChannelHost, ToolPort } from '@agent-layers/core';
import { createMcpServerChannel } from '../src/index.ts';

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
