import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OtlpSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  startTimeUnixNano: string; endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  events?: { name: string; attributes: { key: string; value: Record<string, unknown> }[] }[];
  status?: { code: number; message?: string };
}

export interface Collector {
  url: string;
  requests: { path: string; headers: IncomingMessage['headers']; body: any }[];
  /** Make every request answer with this status. */
  failWith(status: number | undefined): void;
  spans(): OtlpSpan[];
  metrics(): any[];
  resources(): any[];
  close(): Promise<void>;
}

/** A minimal OTLP/HTTP JSON receiver. */
export async function collector(): Promise<Collector> {
  const requests: Collector['requests'] = [];
  let status: number | undefined;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') });
      res.writeHead(status ?? 200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const on = (path: string) => requests.filter((r) => r.path === path);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests,
    failWith: (s) => { status = s; },
    spans: () => on('/v1/traces').flatMap((r) => r.body.resourceSpans.flatMap((rs: any) => rs.scopeSpans.flatMap((ss: any) => ss.spans))),
    metrics: () => on('/v1/metrics').flatMap((r) => r.body.resourceMetrics.flatMap((rm: any) => rm.scopeMetrics.flatMap((sm: any) => sm.metrics))),
    resources: () => on('/v1/traces').flatMap((r) => r.body.resourceSpans.map((rs: any) => rs.resource)),
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

/** Value of an attribute from OTLP JSON. */
export function attr(span: { attributes: OtlpSpan['attributes'] }, key: string): unknown {
  const v = span.attributes.find((a) => a.key === key)?.value;
  if (!v) return undefined;
  const [kind, value] = Object.entries(v)[0]!;
  return kind === 'intValue' ? Number(value) : value;
}

/** A server that answers every request with `status` and a Location on a second server, which records what reaches it. */
export async function redirecting(status: number): Promise<{ url: string; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const listen = async (s: ReturnType<typeof createServer>) => {
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  const stop = (s: ReturnType<typeof createServer>) => new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections(); });
  const target = createServer((req, res) => { hits.push(req.url ?? ''); req.resume(); res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); });
  const targetUrl = await listen(target);
  const origin = createServer((req, res) => { req.resume(); res.writeHead(status, { location: `${targetUrl}${req.url ?? '/'}` }).end(); });
  const url = await listen(origin);
  return { url, hits, close: async () => { await Promise.all([stop(origin), stop(target)]); } };
}
