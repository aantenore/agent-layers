import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleRpc } from './rpc.ts';

export interface Seen { method: string; rpc: string | undefined; params: any; headers: IncomingMessage['headers'] }

export interface McpMock {
  url: string;
  requests: Seen[];
  /** The next request that carries the current session id gets a 404, as after a server restart. */
  expireSession(): void;
  close(): Promise<void>;
}

/** Streamable-HTTP MCP fixture server on a random port. */
export async function startMcpMock(opts: { sse?: boolean; requireAuth?: string } = {}): Promise<McpMock> {
  const requests: Seen[] = [];
  let session = 0;
  let expired = new Set<string>();
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const msg = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method ?? '', rpc: msg?.method, params: msg?.params, headers: req.headers });
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    if (opts.requireAuth && req.headers.authorization !== opts.requireAuth) { res.writeHead(401).end('unauthorized'); return; }
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (sid && expired.has(sid)) { res.writeHead(404).end('unknown session'); return; }
    if (msg.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    const out = handleRpc(msg, { authorization: req.headers.authorization, 'x-api-key': req.headers['x-api-key'] as string | undefined });
    const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...out });
    const headers: Record<string, string> = msg.method === 'initialize' ? { 'mcp-session-id': `s${++session}` } : {};
    if (opts.sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
      res.write(`: hello\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\n\n`);
      // The response arrives split across two writes.
      res.write(`event: message\ndata: ${payload.slice(0, 20)}`);
      setTimeout(() => res.end(`${payload.slice(20)}\n\n`), 5);
    } else {
      res.writeHead(200, { 'content-type': 'application/json', ...headers });
      res.end(payload);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    expireSession: () => { expired = new Set(Array.from({ length: session }, (_, i) => `s${i + 1}`)); },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
