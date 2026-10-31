import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { TelemetryPort } from '@agent-layers/core';
import { createMcpTools } from '../src/index.ts';

test('HTTP requests to an MCP server carry the trace context of the active span', async () => {
  const seen: { method: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (!raw) { res.writeHead(204).end(); return; }
    const msg = JSON.parse(raw) as { id?: number; method: string };
    seen.push({ method: msg.method, headers: req.headers });
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    const result = msg.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 't', version: '1' } }
      : msg.method === 'tools/list'
        ? { tools: [{ name: 'echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
        : { content: [{ type: 'text', text: 'ok' }] };
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  let active = true;
  const telemetry = { span: (_n, _a, fn) => fn({} as never), event() {}, metric() {}, current: () => (active ? { traceparent } : undefined) } as TelemetryPort;
  const tools = createMcpTools({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` }, { telemetry });
  try {
    const ctx = { runId: 'r', agent: 'a' };
    await tools.listTools(ctx);
    active = false;
    assert.equal((await tools.callTool('echo', {}, ctx)).content, 'ok');
    assert.ok(seen.filter((s) => s.method !== 'tools/call').every((s) => s.headers.traceparent === traceparent));
    assert.equal(seen.find((s) => s.method === 'tools/call')?.headers.traceparent, undefined, 'no span, no header');
  } finally {
    await tools.close?.();
    server.close();
  }
});
