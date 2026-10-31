import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Identity } from '@agent-layers/core';
import { ACCESS_TOKEN_TYPE, createOidcCredentials, TOKEN_EXCHANGE_GRANT, type OidcCredentialsOptions } from '../src/index.ts';
import { b64, json, nowSec, server, type Handler } from './helpers.ts';

const fakeJwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256' })}.${b64(claims)}.c2ln`;

/** Token endpoint that answers with a fresh token per request (`tok-<n>`), recording the form parameters. */
async function tokenServer(answer?: (form: URLSearchParams, n: number) => Record<string, unknown> | [number, Record<string, unknown>]) {
  const forms: URLSearchParams[] = [];
  let release: (() => void) | undefined;
  const handler: Handler = async (req, res) => {
    const form = new URLSearchParams(req.body);
    forms.push(form);
    if (gate.closed) await new Promise<void>((r) => { release = r; });
    const out = answer?.(form, forms.length) ?? { access_token: `tok-${forms.length}`, token_type: 'Bearer', expires_in: 300 };
    const [status, body] = Array.isArray(out) ? out : [200, out];
    json(status, body)(req, res);
  };
  const gate = { closed: false, open: () => { gate.closed = false; release?.(); } };
  const s = await server({ '/token': handler });
  return { ...s, forms, gate, endpoint: `${s.url}/token` };
}

const alice = (exp = nowSec() + 600): Identity => ({ subject: 'alice', kind: 'user', token: fakeJwt({ sub: 'alice', exp }), claims: { exp } });
const base = (endpoint: string, o: Partial<OidcCredentialsOptions> = {}): OidcCredentialsOptions =>
  ({ tokenEndpoint: endpoint, clientId: 'agent runtime', clientSecret: 's3cret:+/', mode: 'self', ...o });

describe('client_credentials (self)', () => {
  test('requests a token as the agent with basic auth, audience and scopes; caches it', async () => {
    const s = await tokenServer();
    try {
      const c = createOidcCredentials(base(s.endpoint));
      assert.equal(await c.token('tools-api', { scopes: ['b', 'a', 'a'], identity: alice() }), 'tok-1');
      assert.equal(await c.token('tools-api', { scopes: ['a', 'b'] }), 'tok-1', 'cached; identity does not matter in self mode');
      assert.equal(s.forms.length, 1);
      const f = s.forms[0]!;
      assert.deepEqual(Object.fromEntries(f), { grant_type: 'client_credentials', audience: 'tools-api', scope: 'a b' });
      assert.equal(s.requests[0]!.headers.authorization, `Basic ${Buffer.from('agent+runtime:s3cret%3A%2B%2F').toString('base64')}`);
      assert.equal(await c.token('other'), 'tok-2', 'another audience is another token');
    } finally {
      await s.close();
    }
  });

  test('client_secret_post, resource parameter, and discovery of the token endpoint', async () => {
    const s = await tokenServer();
    s.routes['/r/.well-known/openid-configuration'] = json(200, { issuer: `${s.url}/r`, token_endpoint: `${s.url}/token` });
    try {
      const c = createOidcCredentials({ issuer: `${s.url}/r`, clientId: 'cid', clientSecret: 'sec', mode: 'self', authMethod: 'client_secret_post', audienceParam: 'resource' });
      assert.equal(await c.token('https://api.example.com'), 'tok-1');
      assert.deepEqual(Object.fromEntries(s.forms[0]!), { grant_type: 'client_credentials', resource: 'https://api.example.com', client_id: 'cid', client_secret: 'sec' });
      assert.equal(s.requests.find((r) => r.path === '/token')!.headers.authorization, undefined);
    } finally {
      await s.close();
    }
  });
});

describe('token exchange (on-behalf-of)', () => {
  test('exchanges the caller token (RFC 8693) and caches per caller token', async () => {
    const s = await tokenServer();
    try {
      const c = createOidcCredentials(base(s.endpoint, { mode: 'on-behalf-of' }));
      const a = alice();
      assert.equal(await c.token('tools-api', { identity: a }), 'tok-1');
      assert.deepEqual(Object.fromEntries(s.forms[0]!), {
        grant_type: TOKEN_EXCHANGE_GRANT, subject_token: a.token, subject_token_type: ACCESS_TOKEN_TYPE, requested_token_type: ACCESS_TOKEN_TYPE, audience: 'tools-api',
      });
      assert.equal(await c.token('tools-api', { identity: a }), 'tok-1');
      const bob: Identity = { subject: 'bob', kind: 'user', token: fakeJwt({ sub: 'bob', exp: nowSec() + 600 }) };
      assert.equal(await c.token('tools-api', { identity: bob }), 'tok-2', 'never another caller\'s token');
      const alice2 = { ...alice(), token: fakeJwt({ sub: 'alice', exp: nowSec() + 900 }) };
      assert.equal(await c.token('tools-api', { identity: alice2 }), 'tok-3', 'keyed by the caller token, not only the subject');
    } finally {
      await s.close();
    }
  });

  test('without a caller token there is no token, never the agent\'s own', async () => {
    const s = await tokenServer();
    try {
      const c = createOidcCredentials(base(s.endpoint, { mode: 'on-behalf-of' }));
      await assert.rejects(c.token('tools-api'), /needs the caller token/);
      await assert.rejects(c.token('tools-api', { identity: { subject: 'x', kind: 'agent' } }), /needs the caller token/);
      await assert.rejects(c.token('tools-api', { identity: alice(nowSec() - 5) }), /expired/);
      await assert.rejects(c.token('', { identity: alice() }), /audience is required/);
      assert.equal(s.forms.length, 0);
    } finally {
      await s.close();
    }
  });

  test('a cached on-behalf-of token never outlives the caller token', async () => {
    let t = Date.now();
    const s = await tokenServer((_f, n) => ({ access_token: `tok-${n}`, token_type: 'Bearer', expires_in: 3600 }));
    try {
      const c = createOidcCredentials(base(s.endpoint, { mode: 'on-behalf-of', refreshSkewSec: 10 }), { now: () => t });
      const a = alice(Math.floor(t / 1000) + 60);
      assert.equal(await c.token('tools-api', { identity: a }), 'tok-1');
      t += 45_000;
      assert.equal(await c.token('tools-api', { identity: a }), 'tok-1');
      t += 10_000; // 55 s: within the skew of the caller's exp
      assert.equal(await c.token('tools-api', { identity: a }), 'tok-2');
      t += 10_000; // 65 s: the caller token has expired
      await assert.rejects(c.token('tools-api', { identity: a }), /expired/);
    } finally {
      await s.close();
    }
  });

  test('token lifetime from expires_in, the JWT exp, or the default; too-short tokens are not cached', async () => {
    let t = Date.now();
    const answers: Record<string, unknown>[] = [
      { access_token: fakeJwt({ exp: Math.floor(t / 1000) + 120 }), token_type: 'bearer' },
      { access_token: 'opaque', token_type: 'N_A' },
      { access_token: 'short', token_type: 'Bearer', expires_in: 5 },
      { access_token: 'short-2', token_type: 'Bearer', expires_in: '5' },
    ];
    const s = await tokenServer((_f, n) => answers[n - 1] ?? { access_token: `tok-${n}`, token_type: 'Bearer', expires_in: 300 });
    try {
      const c = createOidcCredentials(base(s.endpoint, { defaultTtlSec: 60 }), { now: () => t });
      const jwt = await c.token('a');
      t += 80_000;
      assert.equal(await c.token('a'), jwt, 'JWT exp 120 s, skew 30 s');
      t += 20_000;
      assert.equal(await c.token('a'), 'opaque', 'refetched past exp - skew');
      t += 25_000;
      assert.equal(await c.token('a'), 'opaque', 'default ttl 60 s');
      t += 10_000;
      assert.equal(await c.token('a'), 'short');
      assert.equal(await c.token('a'), 'short-2', 'a 5 s token is shorter than the skew: not cached');
    } finally {
      await s.close();
    }
  });
});

describe('single flight and failures', () => {
  test('identical concurrent requests share one call; a caller abort leaves the others alone', async () => {
    const s = await tokenServer();
    s.gate.closed = true;
    try {
      const c = createOidcCredentials(base(s.endpoint, { mode: 'on-behalf-of' }));
      const a = alice();
      const ac = new AbortController();
      const first = c.token('tools-api', { identity: a, signal: ac.signal });
      const rest = Array.from({ length: 5 }, () => c.token('tools-api', { identity: a }));
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      await assert.rejects(first, { name: 'AbortError' });
      s.gate.open();
      assert.deepEqual(await Promise.all(rest), Array(5).fill('tok-1'));
      assert.equal(s.forms.length, 1);
      const pre = new AbortController();
      pre.abort();
      await assert.rejects(c.token('fresh', { identity: a, signal: pre.signal }), { name: 'AbortError' });
    } finally {
      await s.close();
    }
  });

  test('refusals and bad responses reject without echoing tokens or the client secret', async () => {
    const a = alice();
    const bodies: [number, Record<string, unknown>, RegExp][] = [
      [400, { error: 'invalid_grant', error_description: `subject_token ${a.token} is not valid` }, /HTTP 400 \(invalid_grant: subject_token \[redacted\] is not valid\)/],
      [401, { error: 'invalid_client' }, /HTTP 401 \(invalid_client\)/],
      [500, { message: `echo ${a.token}` }, /HTTP 500$/],
      [200, { token_type: 'Bearer' }, /no valid access_token/],
      [200, { access_token: 'a b', token_type: 'Bearer' }, /no valid access_token/],
      [200, { access_token: 'x', token_type: 'mac' }, /token_type/],
      [200, { access_token: 'x', token_type: 'Bearer', issued_token_type: 'urn:ietf:params:oauth:token-type:refresh_token' }, /issued_token_type/],
    ];
    for (const [status, body, pattern] of bodies) {
      const s = await tokenServer(() => [status, body]);
      try {
        const c = createOidcCredentials(base(s.endpoint, { mode: 'on-behalf-of' }));
        await assert.rejects(c.token('tools-api', { identity: a }), (err: Error) => {
          assert.match(err.message, pattern);
          assert.ok(!err.message.includes(a.token!) && !err.message.includes('s3cret'), err.message);
          return true;
        });
      } finally {
        await s.close();
      }
    }
  });

  test('redirects and unreachable endpoints fail; https is required outside loopback', async () => {
    const s = await server({ '/token': (_req, res) => { res.writeHead(307, { location: '/elsewhere' }).end(); } });
    try {
      await assert.rejects(createOidcCredentials(base(`${s.url}/token`)).token('a'), /redirect|request failed/);
      assert.equal(s.count('/elsewhere'), 0);
    } finally {
      await s.close();
    }
    await assert.rejects(createOidcCredentials(base('http://127.0.0.1:1/token', { timeoutMs: 2000 })).token('a'), /request failed/);
    assert.throws(() => createOidcCredentials(base('http://idp.example.com/token')), /https/);
    assert.throws(() => createOidcCredentials({ clientId: 'x', clientSecret: 'y', mode: 'self' }), /issuer/);
    assert.throws(() => createOidcCredentials({ tokenEndpoint: 'https://x', clientId: 'x', clientSecret: '', mode: 'self' }), /clientSecret/);
    assert.throws(() => createOidcCredentials({ tokenEndpoint: 'https://x', clientId: 'x', clientSecret: 'y', mode: 'auto' as 'self' }), /mode/);
  });
});
