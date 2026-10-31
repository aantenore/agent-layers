import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Seen { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers']; body: string }
export interface ApiMock { url: string; requests: Seen[]; close(): Promise<void> }

/** Small echo API on a random port. `files` by path, `/status/:code`, `/bytes`, `/big`, `/text` and `/echo` (JSON of what it received). */
export async function startApi(files: Record<string, string> = {}): Promise<ApiMock> {
  const requests: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? '/', 'http://x');
    const seen: Seen = { method: req.method ?? '', path: url.pathname, query: url.searchParams, headers: req.headers, body };
    requests.push(seen);
    if (files[url.pathname]) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(files[url.pathname]); return; }
    const status = /^\/status\/(\d+)$/.exec(url.pathname);
    if (status) { res.writeHead(Number(status[1]), { 'content-type': 'text/plain' }); res.end(`status ${status[1]}`); return; }
    if (url.pathname === '/bytes') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.alloc(32)); return; }
    if (url.pathname === '/big') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(100)); return; }
    if (url.pathname === '/empty') { res.writeHead(204).end(); return; }
    if (url.pathname.startsWith('/text/')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(decodeURIComponent(url.pathname.slice(6))); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      method: seen.method, path: url.pathname, query: Object.fromEntries([...new Set(url.searchParams.keys())].map((k) => [k, url.searchParams.getAll(k)])),
      headers: { authorization: req.headers.authorization ?? null, 'x-trace': req.headers['x-trace'] ?? null, 'x-api-key': req.headers['x-api-key'] ?? null },
      json: body ? JSON.parse(body) : null,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
