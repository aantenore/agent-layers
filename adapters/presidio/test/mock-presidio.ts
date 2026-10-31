import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Call { path: string; body: any; headers: IncomingMessage['headers'] }

export interface MockPresidio {
  analyzerUrl: string;
  anonymizerUrl: string;
  calls: Call[];
  /** Make the next requests answer with this status. */
  failWith(status: number | undefined): void;
  close(): Promise<void>;
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;

/** A stand-in for the Presidio analyzer and anonymizer that knows one entity type: EMAIL_ADDRESS. */
export async function mockPresidio(): Promise<MockPresidio> {
  const calls: Call[] = [];
  let status: number | undefined;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url ?? '', body, headers: req.headers });
      if (status) { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `echo of ${body.text}` })); return; }
      res.setHeader('content-type', 'application/json');
      if (req.url === '/analyze') {
        const found = [...String(body.text).matchAll(EMAIL)].map((m) => ({ entity_type: 'EMAIL_ADDRESS', start: m.index!, end: m.index! + m[0].length, score: 1 }));
        res.end(JSON.stringify(found.filter((f) => f.score >= (body.score_threshold ?? 0))));
      } else if (req.url === '/anonymize') {
        let text = String(body.text);
        for (const r of [...body.analyzer_results].sort((a: any, b: any) => b.start - a.start)) text = `${text.slice(0, r.start)}<${r.entity_type}>${text.slice(r.end)}`;
        res.end(JSON.stringify({ text, items: [] }));
      } else res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    analyzerUrl: base, anonymizerUrl: base, calls,
    failWith: (s) => { status = s; },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

/** A server that answers every request with `status` and a Location on a second server, which records what reaches it. */
export async function redirecting(status: number): Promise<{ url: string; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const listen = async (s: Server) => {
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  const stop = (s: Server) => new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections(); });
  const target = createServer((req, res) => { hits.push(req.url ?? ''); req.resume(); res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); });
  const targetUrl = await listen(target);
  const origin = createServer((req, res) => { req.resume(); res.writeHead(status, { location: `${targetUrl}${req.url ?? '/'}` }).end(); });
  const url = await listen(origin);
  return { url, hits, close: async () => { await Promise.all([stop(origin), stop(target)]); } };
}
