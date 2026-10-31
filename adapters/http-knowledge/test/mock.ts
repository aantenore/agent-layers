import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Seen { headers: IncomingMessage['headers']; body: Record<string, any> }
export interface KnowledgeMock { url: string; requests: Seen[]; close(): Promise<void> }

const DOCS = [
  { id: 'tide', text: 'The Zorblax tide gate closes at 14:20.', source: 'tide.md', score: 0.9, metadata: { file: 'tide.md' } },
  { id: 'vault', text: 'The vault code rotates every 9 days.', source: 'vault.md', score: 0.7, metadata: { file: 'vault.md' } },
  { id: 'quay', text: 'Quay nine is closed on Sundays.', source: 'quay.md', score: 0.5, metadata: { file: 'quay.md' } },
];

/** A service that implements the knowledge HTTP contract: word match, metadata filter, at most `k` passages. */
export async function startKnowledgeService(respond?: (body: Record<string, any>, headers: IncomingMessage['headers']) => { status?: number; json?: unknown; text?: string }): Promise<KnowledgeMock> {
  const requests: Seen[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ headers: req.headers, body });
    if (respond) {
      const out = respond(body, req.headers);
      res.writeHead(out.status ?? 200, { 'content-type': out.json !== undefined ? 'application/json' : 'text/plain' });
      res.end(out.json !== undefined ? JSON.stringify(out.json) : (out.text ?? ''));
      return;
    }
    const words = String(body.query ?? '').toLowerCase().split(/\W+/).filter(Boolean);
    const passages = DOCS
      .filter((d) => words.some((w) => d.text.toLowerCase().includes(w)))
      .filter((d) => !body.filter || Object.entries(body.filter).every(([k, v]) => (d.metadata as Record<string, unknown>)[k] === v))
      .slice(0, body.k ?? 10);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ passages }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/search`, requests, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
