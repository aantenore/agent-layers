// Run bounds across MCP hops: a stack serving its tools over MCP applies the bounds a call carries, so a tool that
// calls back over MCP keeps counting hops and a loop stops at the hop limit.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { compose, defineAdapter, findRoute, PORT_VERSIONS, resolveProfile, runLimits, startRun, type CallContext, type ToolPort } from '@agent-layers/core';
import { createMcpServerChannel, createMcpTools } from '../../src/mcp/index.ts';

test('a loop A → B → A over MCP stops at the hop limit', async () => {
  let client: ToolPort | undefined;
  const seen: CallContext[] = [];
  const relay: ToolPort = {
    listTools: async () => [{ name: 'hop', description: 'Calls back over MCP', params: { type: 'object' }, risk: 'read' }],
    async callTool(_name, _args, ctx) {
      seen.push(ctx);
      if (seen.length > 10) return { ok: true, text: 'runaway' };
      return client!.callTool('relay__hop', {}, ctx);
    },
  };
  const relayAdapter = defineAdapter({
    layer: 'tool', port: 'ToolPort', name: 'relay', direction: 'outbound', maps: { technology: 'test double' },
    portVersion: PORT_VERSIONS.ToolPort, tiers: ['prototype'], optionsSchema: { type: 'object' }, create: () => relay,
  });
  const stack = await compose(resolveProfile({ layers: { tools: { relay: { adapter: 'relay' } } }, limits: { run: { maxHops: 2 } } }), { adapters: [relayAdapter] });
  const mount = await createMcpServerChannel().mount!(stack.host());
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const origin = `http://${req.headers.host}`;
    const request = new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
    const { route } = findRoute(mount.routes, request.method, new URL(request.url).pathname);
    if (!route) { res.writeHead(404).end(); return; }
    const response = await route.handle(request, { requestId: 'r', signal: new AbortController().signal, origin, caller: { id: 'peer', kind: 'agent', roles: [], scopes: [] } });
    res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  client = createMcpTools({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` });
  try {
    const { ledger } = startRun({ runId: 'origin' }, runLimits({}));
    const out = await client.callTool('relay__hop', {}, { runId: 'origin', agent: 'a', bounds: ledger.view });
    assert.equal(out.ok, false);
    assert.match(out.text, /hop_limit/);
    assert.deepEqual(seen.map((c) => c.bounds?.hops), [1, 2], 'each hop counts; the third is refused before the tool runs');
    assert.deepEqual(seen[1]!.lineage?.rootRunId, 'origin');
  } finally {
    await client.close?.();
    server.closeAllConnections();
    server.close();
    await mount.close?.();
    await stack.close();
  }
});
