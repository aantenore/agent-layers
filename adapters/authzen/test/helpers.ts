import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AccessQuestion } from '@agent-layers/core';

/** The reference policy, over the AuthZEN wire: viewer reads, analyst writes, the authenticated agent reads. */
export function referencePolicy(req: any): { allow: boolean; reason: string } {
  const risk = req.resource?.properties?.risk;
  const roles = Array.isArray(req.subject?.properties?.roles) ? req.subject.properties.roles : [];
  const userRisks: Record<string, string[]> = { viewer: ['read'], analyst: ['read', 'write'] };
  const allow = (req.subject?.type === 'user' && req.subject.properties?.authenticated === true && roles.some((r: string) => userRisks[r]?.includes(String(risk))))
    || (req.subject?.type === 'agent' && req.subject.properties?.authenticated === true && risk === 'read');
  return { allow, reason: allow ? 'allowed' : `${req.subject?.type} ${req.subject?.id} may not call ${String(risk)} tools` };
}

export type Reply = (body: any, headers: IncomingHttpHeaders, res: ServerResponse) => unknown;

/** A local PDP: records each request and answers through `reply`. */
export async function pdp(reply: Reply) {
  const seen: { path: string; body: any; headers: IncomingHttpHeaders }[] = [];
  const state = { reply };
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body: unknown;
      try { body = JSON.parse(raw); } catch { body = raw; }
      seen.push({ path: new URL(req.url ?? '/', 'http://x').pathname, body, headers: req.headers });
      try {
        await state.reply(body, req.headers, res);
      } catch {
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    seen, state,
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

export const send = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body));

/** A question about `notes__save` for `caller` (any shape, to probe malformed callers). */
export const question = (caller: unknown, risk: 'read' | 'write' | 'exec' = 'read', args: Record<string, unknown> = { path: '/etc/secret' }): AccessQuestion => ({
  caller: caller as AccessQuestion['caller'], action: 'call', target: { kind: 'tool', id: 'notes__save', layer: 'tool', risk, agent: 'notes' }, args,
});
