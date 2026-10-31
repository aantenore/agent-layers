import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export interface TestKey { kid: string; alg: string; privateKey: KeyObject; jwk: Record<string, unknown> }

export function rsaKey(kid: string, bits = 2048, alg = 'RS256'): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  return { kid, alg, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg } };
}

export function ecKey(kid: string, curve = 'P-256', alg = 'ES256'): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: curve });
  return { kid, alg, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg } };
}

export function edKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { kid, alg: 'EdDSA', privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'EdDSA' } };
}

/** Signs a compact JWS with `key`; `header` overrides the default header. */
export function signJwt(key: TestKey, payload: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const h = { alg: key.alg, kid: key.kid, typ: 'JWT', ...header };
  const input = `${b64(h)}.${b64(payload)}`;
  const alg = String(h.alg);
  let sig: Buffer;
  if (alg.startsWith('RS')) sig = sign(`sha${alg.slice(2)}`, Buffer.from(input), key.privateKey);
  else if (alg.startsWith('PS')) sig = sign(`sha${alg.slice(2)}`, Buffer.from(input), { key: key.privateKey, padding: 6, saltLength: Number(alg.slice(2)) / 8 });
  else if (alg.startsWith('ES')) sig = sign(`sha${alg.slice(2)}`, Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  else sig = sign(null, Buffer.from(input), key.privateKey);
  return `${input}.${sig.toString('base64url')}`;
}

/** HS256 token keyed with `secret` (used to forge an algorithm-confusion token). */
export function hmacJwt(secret: string | Buffer, payload: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const input = `${b64({ alg: 'HS256', typ: 'JWT', ...header })}.${b64(payload)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

export type Handler = (req: IncomingMessage & { body: string }, res: ServerResponse) => void | Promise<void>;

/** A local HTTP server; `route` maps a path to a handler and every request is recorded. */
export async function server(routes: Record<string, Handler>) {
  const requests: { path: string; method: string; headers: IncomingMessage['headers']; body: string }[] = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      requests.push({ path, method: req.method ?? '', headers: req.headers, body });
      const handler = routes[path];
      if (!handler) { res.writeHead(404).end('{}'); return; }
      try {
        await handler(Object.assign(req, { body }), res);
      } catch {
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return {
    url, requests, routes,
    count: (path: string) => requests.filter((r) => r.path === path).length,
    close: () => new Promise<void>((resolve) => { srv.closeAllConnections(); srv.close(() => resolve()); }),
  };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
};

/** A mock OpenID provider: discovery and a mutable JWKS. */
export async function idp(keys: TestKey[]) {
  const state = { keys, jwksStatus: 200 };
  const s = await server({});
  const issuer = `${s.url}/realms/test`;
  s.routes['/realms/test/.well-known/openid-configuration'] = json(200, { issuer, jwks_uri: `${s.url}/jwks`, token_endpoint: `${s.url}/token` });
  s.routes['/jwks'] = (_req, res) => {
    res.writeHead(state.jwksStatus, { 'content-type': 'application/json' }).end(JSON.stringify(state.jwksStatus === 200 ? { keys: state.keys.map((k) => k.jwk) } : {}));
  };
  return { ...s, issuer, state };
}

export const nowSec = () => Math.floor(Date.now() / 1000);
