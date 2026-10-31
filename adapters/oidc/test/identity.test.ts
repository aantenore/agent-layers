import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createOidcIdentity, defaultKind, MAX_RESPONSE_BYTES, type OidcIdentityOptions } from '../src/index.ts';
import { b64, ecKey, edKey, hmacJwt, idp, json, nowSec, rsaKey, server, signJwt } from './helpers.ts';

const rs = rsaKey('rs-1');
const es = ecKey('es-1');
let p: Awaited<ReturnType<typeof idp>>;

before(async () => { p = await idp([rs, es]); });
after(() => p.close());

const claims = (over: Record<string, unknown> = {}) => ({
  iss: p.issuer, aud: 'agent-runtime', sub: 'u-alice', exp: nowSec() + 300, iat: nowSec(), azp: 'web',
  preferred_username: 'alice', realm_access: { roles: ['analyst'] }, resource_access: { api: { roles: ['editor'] }, other: { roles: ['x'] } },
  scope: 'openid profile tools.read', ...over,
});
const port = (o: Partial<OidcIdentityOptions> = {}, hooks = {}) => createOidcIdentity({ issuer: p.issuer, audience: 'agent-runtime', ...o }, hooks);

/** Rejects, and the error message does not echo the token. */
async function refused(verify: Promise<unknown>, token: string, pattern: RegExp) {
  await assert.rejects(verify, (err: Error) => {
    assert.match(err.message, pattern);
    assert.ok(!err.message.includes(token), 'error message must not contain the token');
    return true;
  });
}

describe('verify', () => {
  test('accepts a valid token and maps subject, kind, roles, scopes and claims', async () => {
    const token = signJwt(rs, claims());
    const id = await port().verify(token);
    assert.equal(id.subject, 'u-alice');
    assert.equal(id.kind, 'user');
    assert.deepEqual(id.roles, ['analyst', 'editor', 'x']);
    assert.deepEqual(id.scopes, ['openid', 'profile', 'tools.read']);
    assert.equal(id.claims?.preferred_username, 'alice');
    assert.equal(id.token, token);
    assert.deepEqual((await port({ roleClients: ['api'] }).verify(token)).roles, ['analyst', 'editor']);
  });

  test('accepts ES256, and EdDSA / PS256 only when allowed', async () => {
    assert.equal((await port().verify(signJwt(es, claims()))).subject, 'u-alice');
    const ed = edKey('ed-1');
    const ps = rsaKey('ps-1', 2048, 'PS256');
    p.state.keys = [rs, es, ed, ps];
    try {
      await refused(port().verify(signJwt(ed, claims())), 'x', /not allowed/);
      assert.equal((await port({ algorithms: ['EdDSA', 'PS256'] }).verify(signJwt(ed, claims()))).subject, 'u-alice');
      assert.equal((await port({ algorithms: ['PS256'] }).verify(signJwt(ps, claims()))).subject, 'u-alice');
    } finally {
      p.state.keys = [rs, es];
    }
  });

  test('refuses alg none, HS256 confusion with the public key, and algorithms off the allow-list', async () => {
    const payload = claims();
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
    await refused(port().verify(none), none, /not accepted/);
    const confusion = hmacJwt(JSON.stringify(rs.jwk), payload, { kid: 'rs-1' });
    await refused(port().verify(confusion), confusion, /not accepted/);
    const rs512 = signJwt(rs, payload, { alg: 'RS512' });
    await refused(port().verify(rs512), rs512, /not allowed/);
    assert.throws(() => port({ algorithms: ['HS256'] }), /not accepted/);
    assert.throws(() => port({ algorithms: ['none'] }), /not accepted/);
  });

  test('refuses forged, tampered and malformed tokens', async () => {
    const good = signJwt(rs, claims());
    const [h, b, s] = good.split('.');
    const tampered = `${h}.${b64(claims({ sub: 'u-admin' }))}.${s}`;
    await refused(port().verify(tampered), tampered, /signature/);
    const wrongKey = signJwt({ ...rsaKey('rs-1'), kid: 'rs-1' }, claims());
    await refused(port().verify(wrongKey), wrongKey, /signature/);
    for (const bad of ['', 'not-a-jwt', 'a.b', 'a.b.c.d', `${h}.${b}.!!`, `${b64('[]')}.${b}.${s}`, `${h}.${b64('"str"')}.${s}`, 'x'.repeat(20_000)]) {
      await refused(port().verify(bad), 'never-in-messages', /malformed|signature|alg/);
    }
    const unsigned = `${h}.${b}.`;
    await refused(port().verify(unsigned), unsigned, /signature/);
  });

  test('checks iss, aud, exp, nbf, iat and token age', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ iss: `${p.issuer}/` }, /issuer/],
      [{ iss: undefined }, /issuer/],
      [{ aud: 'tools-api' }, /audience/],
      [{ aud: undefined }, /audience/],
      [{ exp: undefined }, /no "exp"/],
      [{ exp: '9999999999' }, /no "exp"/],
      [{ exp: nowSec() - 120 }, /expired/],
      [{ nbf: nowSec() + 300 }, /not yet valid/],
      [{ nbf: 'soon' }, /not yet valid/],
      [{ iat: nowSec() + 300 }, /future/],
      [{ sub: undefined, azp: undefined }, /subject/],
      [{ sub: 42 }, /subject/],
    ];
    for (const [over, pattern] of cases) {
      const token = signJwt(rs, claims(over));
      await refused(port().verify(token), token, pattern);
    }
    assert.equal((await port({ audience: ['tools-api', 'agent-runtime'] }).verify(signJwt(rs, claims({ aud: ['x', 'agent-runtime'] })))).subject, 'u-alice');
    assert.equal((await port().verify(signJwt(rs, claims({ exp: nowSec() - 30 })))).subject, 'u-alice', 'within clock skew');
    const old = signJwt(rs, claims({ iat: nowSec() - 3600 }));
    await refused(port({ maxTokenAgeSec: 600 }).verify(old), old, /too old/);
    const noIat = signJwt(rs, claims({ iat: undefined }));
    await refused(port({ maxTokenAgeSec: 600 }).verify(noIat), noIat, /no "iat"/);
  });

  test('requires an audience unless any audience is explicitly allowed', async () => {
    assert.throws(() => createOidcIdentity({ issuer: p.issuer }), /audience/);
    assert.throws(() => createOidcIdentity({ issuer: p.issuer, audience: [] }), /audience/);
    const any = createOidcIdentity({ issuer: p.issuer, allowAnyAudience: true });
    assert.equal((await any.verify(signJwt(rs, claims({ aud: 'whatever' })))).subject, 'u-alice');
  });

  test('refuses critical header parameters and, when configured, other token types', async () => {
    const crit = signJwt(rs, claims(), { crit: ['exp'], exp: 1 });
    await refused(port().verify(crit), crit, /critical/);
    const b64Off = signJwt(rs, claims(), { crit: ['b64'], b64: false });
    await refused(port().verify(b64Off), b64Off, /critical/);
    const at = signJwt(rs, claims(), { typ: 'at+jwt' });
    assert.equal((await port({ types: ['at+jwt'] }).verify(at)).subject, 'u-alice');
    assert.equal((await port({ types: ['at+jwt'] }).verify(signJwt(rs, claims(), { typ: 'application/AT+JWT' }))).subject, 'u-alice');
    const idToken = signJwt(rs, claims());
    await refused(port({ types: ['at+jwt'] }).verify(idToken), idToken, /type/);
  });

  test('client-credentials tokens are the agent; spoofed service-account names are not', async () => {
    const agent = await port().verify(signJwt(rs, claims({ sub: 'sa-uuid', azp: 'agent-runtime', preferred_username: 'service-account-agent-runtime', realm_access: {} })));
    assert.equal(agent.kind, 'agent');
    assert.equal((await port().verify(signJwt(rs, claims({ sub: undefined, client_id: 'svc' })))).subject, 'svc');
    assert.equal(defaultKind({ sub: 'svc', client_id: 'svc' }), 'agent');
    assert.equal(defaultKind({ sub: 'u', azp: 'web', preferred_username: 'service-account-agent-runtime' }), 'user');
    assert.equal(defaultKind({ sub: 'u', azp: 'agent-runtime', preferred_username: 'alice' }), 'user');
  });

  test('refuses weak or mismatched keys', async () => {
    const weak = rsaKey('weak', 1024);
    const p256as384 = ecKey('mismatch', 'P-256', 'ES384');
    p.state.keys = [rs, es, weak, { ...p256as384, jwk: { ...p256as384.jwk, alg: undefined } }];
    try {
      const w = signJwt(weak, claims());
      await refused(port().verify(w), w, /2048/);
      const m = signJwt(p256as384, claims());
      await refused(port({ algorithms: ['ES384'] }).verify(m), m, /curve/);
    } finally {
      p.state.keys = [rs, es];
    }
  });
});

describe('transport', () => {
  test('https is required outside loopback; URLs with credentials are refused', () => {
    assert.throws(() => createOidcIdentity({ issuer: 'http://idp.example.com/realms/a', audience: 'x' }), /https/);
    assert.throws(() => createOidcIdentity({ issuer: 'https://idp.example.com', audience: 'x', jwksUri: 'http://keys.example.com/jwks' }), /https/);
    assert.throws(() => createOidcIdentity({ issuer: 'https://user:pw@idp.example.com', audience: 'x' }), /credentials/);
    assert.throws(() => createOidcIdentity({ issuer: 'ftp://idp.example.com', audience: 'x' }), /https/);
    for (const issuer of ['https://idp.example.com', 'http://localhost:8080/r', 'http://127.0.0.1/r', 'http://[::1]/r', 'http://kc.localhost/r']) {
      createOidcIdentity({ issuer, audience: 'x' });
    }
    createOidcIdentity({ issuer: 'http://idp.internal/r', audience: 'x', allowHttp: true });
  });

  test('discovery must name the expected issuer', async () => {
    const s = await server({});
    s.routes['/.well-known/openid-configuration'] = json(200, { issuer: 'https://evil.example.com', jwks_uri: `${s.url}/jwks` });
    try {
      const token = signJwt(rs, claims({ iss: s.url }));
      await refused(createOidcIdentity({ issuer: s.url, audience: 'agent-runtime' }).verify(token), token, /different issuer/);
    } finally {
      await s.close();
    }
  });

  test('redirects are not followed and oversized documents are refused', async () => {
    const s = await server({
      '/redirect': (_req, res) => { res.writeHead(302, { location: '/jwks' }).end(); },
      '/huge': (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(`{"keys":[],"pad":"${'x'.repeat(MAX_RESPONSE_BYTES)}"}`); },
      '/chunked': (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"keys":[],"pad":"');
        const chunk = 'x'.repeat(64 * 1024);
        for (let i = 0; i < 20; i++) res.write(chunk);
        res.end('"}');
      },
    });
    try {
      const token = signJwt(rs, claims());
      for (const path of ['/redirect', '/huge', '/chunked']) {
        await refused(port({ jwksUri: `${s.url}${path}` }).verify(token), token, path === '/redirect' ? /redirect|request failed/ : /too large/);
      }
      assert.equal(s.count('/jwks'), 0, 'the redirect target is never fetched');
    } finally {
      await s.close();
    }
  });
});

describe('JWKS cache', () => {
  test('one fetch for concurrent verifications; an unknown kid refetches, rate limited', async () => {
    let t = Date.now();
    const local = await idp([rs]);
    try {
      const v = createOidcIdentity({ issuer: local.issuer, audience: 'agent-runtime', jwksMinRefreshMs: 30_000 }, { now: () => t });
      const c = claims({ iss: local.issuer });
      await Promise.all(Array.from({ length: 10 }, () => v.verify(signJwt(rs, c))));
      assert.equal(local.count('/jwks'), 1);
      assert.equal(local.count('/realms/test/.well-known/openid-configuration'), 1);

      // Rotation: a new key appears; the first token with its kid refetches.
      const next = rsaKey('rs-2');
      local.state.keys = [rs, next];
      t += 31_000;
      assert.equal((await v.verify(signJwt(next, c))).subject, 'u-alice');
      assert.equal(local.count('/jwks'), 2);

      // Unknown kids within the refresh interval do not hit the provider again.
      const ghost = rsaKey('ghost');
      for (let i = 0; i < 5; i++) await assert.rejects(v.verify(signJwt(ghost, c)), /no signing key/);
      assert.equal(local.count('/jwks'), 2);
      t += 31_000;
      await assert.rejects(v.verify(signJwt(ghost, c)), /no signing key/);
      assert.equal(local.count('/jwks'), 3);

      // A rotated-out key stops verifying after the next refresh.
      local.state.keys = [next];
      t += 11 * 60_000;
      await assert.rejects(v.verify(signJwt(rs, c)), /no signing key/);
    } finally {
      await local.close();
    }
  });

  test('keeps serving the previous keys while the provider is down; the first failure is rate limited', async () => {
    let t = Date.now();
    const local = await idp([rs]);
    try {
      const v = createOidcIdentity({ issuer: local.issuer, audience: 'agent-runtime', jwksMaxAgeMs: 1000, jwksMinRefreshMs: 5000 }, { now: () => t });
      const token = signJwt(rs, claims({ iss: local.issuer }));
      await v.verify(token);
      local.state.jwksStatus = 503;
      t += 10_000;
      assert.equal((await v.verify(token)).subject, 'u-alice', 'stale keys still verify');
      assert.equal(local.count('/jwks'), 2);

      const cold = createOidcIdentity({ issuer: local.issuer, audience: 'agent-runtime', jwksMinRefreshMs: 5000 }, { now: () => t });
      await assert.rejects(cold.verify(token), /JWKS: HTTP 503/);
      await assert.rejects(cold.verify(token), /JWKS: HTTP 503/);
      assert.equal(local.count('/jwks'), 3, 'the second attempt is served from the remembered error');
      local.state.jwksStatus = 200;
      t += 6000;
      assert.equal((await cold.verify(token)).subject, 'u-alice');
    } finally {
      await local.close();
    }
  });

  test('a caller abort does not cancel the shared fetch', async () => {
    const local = await idp([rs]);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const original = local.routes['/jwks']!;
    local.routes['/jwks'] = async (req, res) => { await gate; await original(req, res); };
    try {
      const v = createOidcIdentity({ issuer: local.issuer, audience: 'agent-runtime' });
      const token = signJwt(rs, claims({ iss: local.issuer }));
      const ac = new AbortController();
      const aborted = v.verify(token, { signal: ac.signal });
      const other = v.verify(token);
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      await assert.rejects(aborted, { name: 'AbortError' });
      release();
      assert.equal((await other).subject, 'u-alice');
    } finally {
      await local.close();
    }
  });
});
