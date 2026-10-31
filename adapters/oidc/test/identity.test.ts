import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createMappings, type MappingFn, type MappingRule } from '@agent-layers/core';
import { agentKind, CALLER_RULES, createOidcIdentity, IDENTITY_LIMITS, type OidcIdentityOptions } from '../src/index.ts';
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
  test('accepts a valid token and maps id, kind, roles, scopes, name and the expiry; claims only on request', async () => {
    const c = claims();
    const token = signJwt(rs, c);
    assert.deepEqual(await port().verify(token), { id: 'u-alice', kind: 'user', roles: ['analyst'], scopes: ['openid', 'profile', 'tools.read'], name: 'alice', credential: token, ext: { 'oidc.exp': c.exp } },
      'realm roles; client roles only of the audience by default; no raw claims');
    assert.deepEqual((await port({ keepClaims: true }).verify(token)).ext?.['oidc.claims'], c);
    assert.deepEqual((await port({ roleClients: ['api'] }).verify(token)).roles, ['analyst', 'api:editor']);
    assert.deepEqual((await port({ roleClients: ['api'], namespaceClientRoles: false }).verify(token)).roles, ['analyst', 'editor']);
  });

  test('accepts ES256, and EdDSA / PS256 only when allowed', async () => {
    assert.equal((await port().verify(signJwt(es, claims()))).id, 'u-alice');
    const ed = edKey('ed-1');
    const ps = rsaKey('ps-1', 2048, 'PS256');
    p.state.keys = [rs, es, ed, ps];
    try {
      await refused(port().verify(signJwt(ed, claims())), 'x', /not allowed/);
      assert.equal((await port({ algorithms: ['EdDSA', 'PS256'] }).verify(signJwt(ed, claims()))).id, 'u-alice');
      assert.equal((await port({ algorithms: ['PS256'] }).verify(signJwt(ps, claims()))).id, 'u-alice');
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
      [{ sub: '' }, /subject/],
      [{ sub: 42 }, /subject/],
    ];
    for (const [over, pattern] of cases) {
      const token = signJwt(rs, claims(over));
      await refused(port().verify(token), token, pattern);
    }
    assert.equal((await port({ audience: ['tools-api', 'agent-runtime'] }).verify(signJwt(rs, claims({ aud: ['x', 'agent-runtime'] })))).id, 'u-alice');
    assert.equal((await port().verify(signJwt(rs, claims({ exp: nowSec() - 30 })))).id, 'u-alice', 'within clock skew');
    const old = signJwt(rs, claims({ iat: nowSec() - 3600 }));
    await refused(port({ maxTokenAgeSec: 600 }).verify(old), old, /too old/);
    const noIat = signJwt(rs, claims({ iat: undefined }));
    await refused(port({ maxTokenAgeSec: 600 }).verify(noIat), noIat, /no "iat"/);
  });

  test('requires an audience unless any audience is explicitly allowed', async () => {
    assert.throws(() => createOidcIdentity({ issuer: p.issuer }), /audience/);
    assert.throws(() => createOidcIdentity({ issuer: p.issuer, audience: [] }), /audience/);
    const any = createOidcIdentity({ issuer: p.issuer, allowAnyAudience: true });
    assert.equal((await any.verify(signJwt(rs, claims({ aud: 'whatever' })))).id, 'u-alice');
  });

  test('refuses critical header parameters and, when configured, other token types', async () => {
    const crit = signJwt(rs, claims(), { crit: ['exp'], exp: 1 });
    await refused(port().verify(crit), crit, /critical/);
    const b64Off = signJwt(rs, claims(), { crit: ['b64'], b64: false });
    await refused(port().verify(b64Off), b64Off, /critical/);
    const at = signJwt(rs, claims(), { typ: 'at+jwt' });
    assert.equal((await port({ types: ['at+jwt'] }).verify(at)).id, 'u-alice');
    assert.equal((await port({ types: ['at+jwt'] }).verify(signJwt(rs, claims(), { typ: 'application/AT+JWT' }))).id, 'u-alice');
    const idToken = signJwt(rs, claims());
    await refused(port({ types: ['at+jwt'] }).verify(idToken), idToken, /type/);
  });

  test('client roles never collide with realm roles and are read only for the listed clients', async () => {
    const token = signJwt(rs, claims({ realm_access: { roles: ['viewer'] }, resource_access: { 'agent-runtime': { roles: ['admin'] }, evil: { roles: ['admin'] }, __proto__: { roles: ['admin'] } } }));
    assert.deepEqual((await port().verify(token)).roles, ['viewer', 'agent-runtime:admin']);
    assert.deepEqual((await port({ roleClients: [] }).verify(token)).roles, ['viewer']);
    assert.deepEqual((await port({ allowAnyAudience: true, audience: undefined }).verify(token)).roles, ['viewer'], 'no audience, no client roles');
    assert.deepEqual((await port({ roleClients: ['toString', 'constructor'] }).verify(token)).roles, ['viewer']);
  });

  test('agent only for allow-listed clients with a client-credentials subject', async () => {
    const sa = claims({ sub: 'sa-uuid', azp: 'agent-runtime', preferred_username: 'service-account-agent-runtime', realm_access: {} });
    assert.equal((await port().verify(signJwt(rs, sa))).kind, 'user', 'no allow-list: never agent');
    assert.equal((await port({ agentClients: ['agent-runtime'] }).verify(signJwt(rs, sa))).kind, 'user', 'sub is neither the client nor its configured subject');
    const agent = await port({ agentClients: ['agent-runtime'], agentSubjects: { 'agent-runtime': 'sa-uuid' } }).verify(signJwt(rs, sa));
    assert.deepEqual([agent.kind, agent.id], ['agent', 'sa-uuid']);
    const rfc9068 = await port({ agentClients: ['svc'] }).verify(signJwt(rs, claims({ sub: 'svc', client_id: 'svc', azp: undefined })));
    assert.deepEqual([rfc9068.kind, rfc9068.id], ['agent', 'svc']);
    const noSub = await port({ agentClients: ['svc'] }).verify(signJwt(rs, claims({ sub: undefined, azp: undefined, client_id: 'svc' })));
    assert.deepEqual([noSub.kind, noSub.id], ['agent', 'svc']);

    // A token exchanged by the agent client on behalf of a user carries azp = agent client but the user's sub.
    const exchanged = await port({ agentClients: ['agent-runtime'], agentSubjects: { 'agent-runtime': 'sa-uuid' } }).verify(signJwt(rs, claims({ azp: 'agent-runtime' })));
    assert.equal(exchanged.kind, 'user');
    // Usernames are user-chosen: they never make an agent.
    const spoof = claims({ sub: 'u-mallory', azp: 'agent-runtime', preferred_username: 'service-account-agent-runtime' });
    assert.equal((await port({ agentClients: ['agent-runtime'] }).verify(signJwt(rs, spoof))).kind, 'user');
    assert.equal(agentKind({ sub: 'web', azp: 'web' }, { agentClients: ['svc'] }), 'user', 'client not allow-listed');
    assert.equal(agentKind({ sub: 'svc', azp: 'svc', client_id: 'other' }, { agentClients: ['svc', 'other'] }), 'user', 'azp and client_id disagree');
    assert.equal(agentKind({ sub: 'svc', azp: 'svc' }, { agentClients: ['svc'], agentSubjects: { svc: 'sa-1' } }), 'user', 'configured subject replaces sub == client');

    // Without sub and without an allow-listed client the token names no one.
    for (const opts of [{}, { agentClients: ['other'] }]) {
      const token = signJwt(rs, claims({ sub: undefined, azp: 'svc' }));
      await refused(port(opts).verify(token), token, /no subject/);
    }
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

describe('claims to caller mappings', () => {
  const mapped = (rules: readonly MappingRule[], o: Partial<OidcIdentityOptions> = {}, fns?: Map<string, MappingFn>) =>
    port(o, { mappings: createMappings('identity', { in: rules }, fns ? { fns } : {}) });

  test('replaced rules change roles, scopes and name; client roles and scp stay in code', async () => {
    const token = signJwt(rs, claims({ groups: ['ops', 'ops'], scp: ['api.read', 'api.write tools.read'], tenant: 'acme' }));
    const caller = await mapped([
      { from: '/groups', to: '/roles' },
      { from: '/scope', to: '/scopes', split: ' ' },
      { from: '/tenant', to: '/ext/oidc.tenant' },
    ], { roleClients: ['api'] }).verify(token);
    assert.deepEqual(caller.roles, ['ops', 'api:editor']);
    assert.deepEqual(caller.scopes, ['openid', 'profile', 'tools.read', 'api.read', 'api.write']);
    assert.equal(caller.name, undefined, 'no name rule, no name');
    assert.equal(caller.ext?.['oidc.tenant'], 'acme');
    assert.deepEqual((await mapped([]).verify(token)).roles, [], 'no rules: no realm roles');
    assert.deepEqual(CALLER_RULES.map((r) => r.to), ['/roles', '/scopes', '/name']);
  });

  test('id, kind and credential cannot be mapped: static rules fail at creation, functions at verification', async () => {
    for (const to of ['/kind', '/id', '/credential']) assert.throws(() => mapped([{ from: '/azp', to }]), /may not write/, to);
    assert.throws(() => mapped([{ drop: '/kind' }]), /may not write/);
    const promote: MappingFn = (_c, target) => ({ ...(target as object), kind: 'agent' });
    const token = signJwt(rs, claims());
    await refused(mapped([{ fn: './x.ts#promote' }], {}, new Map([['./x.ts#promote', promote]])).verify(token), token, /caller mapping failed/);
    const rename: MappingFn = (_c, target) => ({ ...(target as object), id: 'u-admin' });
    await refused(mapped([{ fn: './x.ts#rename' }], {}, new Map([['./x.ts#rename', rename]])).verify(token), token, /caller mapping failed/);
    const credential: MappingFn = (_c, target) => ({ ...(target as object), credential: 'forged', extra: true });
    const caller = await mapped([{ fn: './x.ts#c' }], {}, new Map([['./x.ts#c', credential]])).verify(token);
    assert.equal(caller.credential, token, 'the verified credential always wins');
    assert.equal((caller as unknown as Record<string, unknown>).extra, undefined, 'unknown fields are dropped');
  });

  test('a failing or malformed mapping rejects the token without echoing it', async () => {
    const token = signJwt(rs, claims({ realm_access: { roles: 'admin' } }));
    await refused(mapped([{ from: '/realm_access/roles', to: '/roles' }]).verify(token), token, /roles is not a list/);
    await refused(mapped([{ from: '/sub', to: '/roles/__proto__' }]).verify(token), token, /caller mapping failed/);
    const throws: MappingFn = () => { throw new Error(`boom ${token}`); };
    await assert.rejects(mapped([{ fn: './x.ts#t' }], {}, new Map([['./x.ts#t', throws]])).verify(token), (err: Error) => {
      assert.match(err.message, /caller mapping failed \(rule in\[0\] failed\)/);
      assert.equal(err.cause, undefined, 'no rule error text is kept');
      return true;
    });
    const weird = signJwt(rs, claims({ realm_access: { roles: ['ok', 7, null, ''] }, preferred_username: 42 }));
    const c = await port().verify(weird);
    assert.deepEqual([c.roles, c.name], [['ok'], undefined], 'non-string claim values are dropped');
  });

  test('ext keeps the oidc namespace only; raw claims only with keepClaims', async () => {
    const token = signJwt(rs, claims({ tenant: 'acme' }));
    const rules = [...CALLER_RULES, { from: '/tenant', to: '/ext/oidc.claims' }];
    const other: MappingFn = (_c, target) => ({ ...(target as object), ext: { 'other.key': 1, 'oidc.tenant': 'acme' } });
    const caller = await mapped([...rules, { fn: './x.ts#o' }], {}, new Map([['./x.ts#o', other]])).verify(token);
    assert.deepEqual(Object.keys(caller.ext ?? {}).sort(), ['oidc.exp', 'oidc.tenant']);
    assert.equal((await mapped(rules, { keepClaims: true }).verify(token)).ext?.['oidc.claims'] instanceof Object, true);
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
      '/huge': (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(`{"keys":[],"pad":"${'x'.repeat(IDENTITY_LIMITS.maxResponseBytes.default as number)}"}`); },
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
      assert.equal((await v.verify(signJwt(next, c))).id, 'u-alice');
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
      assert.equal((await v.verify(token)).id, 'u-alice', 'stale keys still verify');
      assert.equal(local.count('/jwks'), 2);

      const cold = createOidcIdentity({ issuer: local.issuer, audience: 'agent-runtime', jwksMinRefreshMs: 5000 }, { now: () => t });
      await assert.rejects(cold.verify(token), /JWKS: HTTP 503/);
      await assert.rejects(cold.verify(token), /JWKS: HTTP 503/);
      assert.equal(local.count('/jwks'), 3, 'the second attempt is served from the remembered error');
      local.state.jwksStatus = 200;
      t += 6000;
      assert.equal((await cold.verify(token)).id, 'u-alice');
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
      assert.equal((await other).id, 'u-alice');
    } finally {
      await local.close();
    }
  });
});
