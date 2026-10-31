import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry } from '@agent-layers/core';
import { createOidcCredentials, createOidcIdentity, credentialAdapter, identityAdapter } from '../src/index.ts';
import { idp, json, nowSec, rsaKey, server, signJwt } from './helpers.ts';

const ctx = { name: 'oidc', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const identityOptions = { issuer: 'http://127.0.0.1:9/realm', audience: 'api' };
const credentialOptions = { issuer: 'http://127.0.0.1:9/realm', clientId: 'agent', clientSecret: 'secret', mode: 'self' };

test('maxTokenChars refuses a longer token before any key is fetched', async () => {
  const key = rsaKey('k1');
  const p = await idp([key]);
  try {
    const token = signJwt(key, { iss: p.issuer, aud: 'api', sub: 'u', exp: nowSec() + 300 });
    const v = createOidcIdentity({ issuer: p.issuer, audience: 'api', maxTokenChars: token.length - 1 });
    await assert.rejects(v.verify(token), /malformed token/);
    assert.equal(p.count('/jwks'), 0);
    await createOidcIdentity({ issuer: p.issuer, audience: 'api', maxTokenChars: token.length }).verify(token);
  } finally {
    await p.close();
  }
});

test('maxResponseBytes caps provider documents', async () => {
  const key = rsaKey('k1');
  const p = await idp([key]);
  try {
    const token = signJwt(key, { iss: p.issuer, aud: 'api', sub: 'u', exp: nowSec() + 300 });
    await assert.rejects(createOidcIdentity({ issuer: p.issuer, audience: 'api', maxResponseBytes: 50 }).verify(token), /too large/);
    await createOidcIdentity({ issuer: p.issuer, audience: 'api', maxResponseBytes: 'unbounded' }).verify(token);
  } finally {
    await p.close();
  }
});

test('maxKeyTries bounds the keys tried for a token without kid', async () => {
  const keys = [rsaKey('a'), rsaKey('b'), rsaKey('c')];
  const p = await idp(keys);
  try {
    const token = signJwt(keys[2]!, { iss: p.issuer, aud: 'api', sub: 'u', exp: nowSec() + 300 }, { kid: undefined });
    await assert.rejects(createOidcIdentity({ issuer: p.issuer, audience: 'api', maxKeyTries: 2 }).verify(token), /invalid token signature/);
    await createOidcIdentity({ issuer: p.issuer, audience: 'api', maxKeyTries: 3 }).verify(token);
  } finally {
    await p.close();
  }
});

test('jwksMinRefreshMs and clockSkewSec take effect', async () => {
  const key = rsaKey('k1');
  const p = await idp([key]);
  try {
    const t = Date.now();
    const expired = signJwt(key, { iss: p.issuer, aud: 'api', sub: 'u', exp: Math.floor(t / 1000) - 100 });
    await assert.rejects(createOidcIdentity({ issuer: p.issuer, audience: 'api', clockSkewSec: 10 }).verify(expired), /expired/);
    await createOidcIdentity({ issuer: p.issuer, audience: 'api', clockSkewSec: 200 }).verify(expired);

    const other = signJwt(rsaKey('zz'), { iss: p.issuer, aud: 'api', sub: 'u', exp: Math.floor(t / 1000) + 300 });
    let now = t;
    const v = createOidcIdentity({ issuer: p.issuer, audience: 'api', jwksMinRefreshMs: 1000 }, { now: () => now });
    await assert.rejects(v.verify(other), /no signing key/);
    const first = p.count('/jwks');
    await assert.rejects(v.verify(other), /no signing key/);
    assert.equal(p.count('/jwks'), first, 'inside the interval no refetch');
    now += 1500;
    await assert.rejects(v.verify(other), /no signing key/);
    assert.equal(p.count('/jwks'), first + 1, 'after the interval a refetch');
  } finally {
    await p.close();
  }
});

test('errorDescriptionChars truncates the provider description', async () => {
  const s = await server({ '/token': json(400, { error: 'invalid_grant', error_description: 'abcdefghij klmnop' }) });
  try {
    const make = (n: number) => createOidcCredentials({ tokenEndpoint: `${s.url}/token`, clientId: 'agent', clientSecret: 'secret', mode: 'self', errorDescriptionChars: n });
    await assert.rejects(make(5).token('a'), (err: Error) => err.message.endsWith('(invalid_grant: abcde)'));
    await assert.rejects(make(0).token('a'), (err: Error) => err.message.endsWith('(invalid_grant: )') || err.message.endsWith('(invalid_grant)'));
  } finally {
    await s.close();
  }
});

test('credential limits: maxCacheEntries and defaultTtlSec take effect', async () => {
  const s = await server({ '/token': json(200, { access_token: 'tok', token_type: 'Bearer' }) });
  try {
    let t = 1_000_000;
    const c = createOidcCredentials({ tokenEndpoint: `${s.url}/token`, clientId: 'agent', clientSecret: 'secret', mode: 'self', maxCacheEntries: 1, defaultTtlSec: 100, refreshSkewSec: 0 }, { now: () => t });
    await c.token('a');
    await c.token('a');
    assert.equal(s.count('/token'), 1, 'cached');
    await c.token('b');
    await c.token('a');
    assert.equal(s.count('/token'), 3, 'one entry only: a was evicted by b');
    t += 101_000;
    await c.token('a');
    assert.equal(s.count('/token'), 4, 'expired after defaultTtlSec');
  } finally {
    await s.close();
  }
});

test('limits from ${env:...} are coerced; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(identityAdapter).register(credentialAdapter);
  await registry.create('IdentityPort', 'oidc', { ...identityOptions, timeoutMs: '2500', jwksMinRefreshMs: '5000', maxResponseBytes: '2000000' }, ctx);
  await registry.create('CredentialPort', 'oidc', { ...credentialOptions, timeoutMs: '2500', maxCacheEntries: '10', refreshSkewSec: '5' }, ctx);
  for (const bad of [{ jwksMinRefreshMs: 0 }, { jwksMaxAgeMs: 0 }, { jwksMinRefreshMs: 'unbounded' }, { jwksMaxAgeMs: 'unbounded' }, { clockSkewSec: -1 }, { clockSkewSec: 601 },
    { maxKeyTries: 0 }, { maxKeyTries: 'unbounded' }, { timeoutMs: 0 }, { maxTokenChars: 0 }, { maxResponseBytes: -1 }, { errorDescriptionChars: -1 }, { errorDescriptionChars: 'unbounded' }]) {
    await assert.rejects(registry.create('IdentityPort', 'oidc', { ...identityOptions, ...bad }, ctx), new RegExp(Object.keys(bad)[0]!), JSON.stringify(bad));
  }
  for (const bad of [{ maxCacheEntries: 0 }, { defaultTtlSec: 0 }, { defaultTtlSec: 'unbounded' }, { refreshSkewSec: -1 }, { refreshSkewSec: 'unbounded' }, { timeoutMs: 0 }, { maxResponseBytes: 0 }]) {
    await assert.rejects(registry.create('CredentialPort', 'oidc', { ...credentialOptions, ...bad }, ctx), new RegExp(Object.keys(bad)[0]!), JSON.stringify(bad));
  }
  for (const ok of [{ timeoutMs: 'unbounded' }, { maxTokenChars: 'unbounded' }, { maxResponseBytes: 'unbounded' }]) {
    await registry.create('IdentityPort', 'oidc', { ...identityOptions, ...ok }, ctx);
  }
  await registry.create('CredentialPort', 'oidc', { ...credentialOptions, maxCacheEntries: 'unbounded', timeoutMs: 'unbounded' }, ctx);
});
