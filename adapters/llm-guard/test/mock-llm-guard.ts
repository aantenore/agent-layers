import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Call { path: string; body: any; headers: IncomingMessage['headers'] }

export interface MockLlmGuard { url: string; token: string; calls: Call[]; close(): Promise<void> }

/**
 * A stand-in for the LLM Guard API with the behavior the adapter relies on: bearer auth (403 without a token, 401 with a wrong one), a
 * `PromptInjection` scanner that fails on "ignore previous instructions" (score 0.97, passing scanners report -1),
 * a `Secrets` scanner that redacts `sk-...` keys (and, like the real one, reports the result as invalid), and `/analyze/output` requiring a `prompt` field.
 */
export async function mockLlmGuard(token = 'good-token'): Promise<MockLlmGuard> {
  const calls: Call[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url ?? '', body, headers: req.headers });
      const send = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload)); };
      // Like the real API: 403 without credentials, 401 with a wrong token.
      if (!req.headers.authorization) return send(403, { message: 'Not authenticated' });
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: 'Invalid API key' });
      const output = req.url === '/analyze/output';
      if (!output && req.url !== '/analyze/prompt') return send(404, {});
      if (output && typeof body.prompt !== 'string') return send(422, { detail: [{ msg: 'prompt required' }] });
      const text: string = output ? body.output : body.prompt;
      const injected = /ignore (all )?previous instructions/i.test(text) && !(body.scanners_suppress ?? []).includes('PromptInjection');
      const sanitized = text.replace(/sk-[A-Za-z0-9]{12,}/g, '[REDACTED]');
      const scanners = { PromptInjection: injected ? 0.97 : -1, Secrets: sanitized !== text ? 1 : -1 };
      send(200, { is_valid: !injected && sanitized === text, scanners, [output ? 'sanitized_output' : 'sanitized_prompt']: sanitized });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token, calls,
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
