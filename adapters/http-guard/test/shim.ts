import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Shim {
  url: string;
  requests: { body: any; headers: IncomingMessage['headers'] }[];
  /** Replace the answer: a status and a JSON body. */
  answer(status: number, body: unknown): void;
  reset(): void;
  close(): Promise<void>;
}

/**
 * A guard service as any language would write it: blocks "forbidden", redacts "secret-123" and allows the rest.
 * `answer` overrides it with a fixed response, to test how the adapter treats bad services.
 */
export async function shim(): Promise<Shim> {
  const requests: Shim['requests'] = [];
  let fixed: { status: number; body: unknown } | undefined;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push({ body, headers: req.headers });
      const send = (status: number, payload: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
      if (fixed) return send(fixed.status, fixed.body);
      const text: string = body.text;
      if (/forbidden/i.test(text)) return send(200, { action: 'block', reason: 'forbidden word' });
      if (text.includes('secret-123')) return send(200, { action: 'redact', text: text.replaceAll('secret-123', '[SECRET]'), reason: 'secret' });
      send(200, { action: 'allow' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/check`, requests,
    answer: (status, body) => { fixed = { status, body }; },
    reset: () => { fixed = undefined; requests.length = 0; },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
