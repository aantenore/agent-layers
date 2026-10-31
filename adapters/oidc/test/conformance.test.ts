import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { credentialAdapter, identityAdapter } from '../src/index.ts';
import { b64, idp, json, nowSec, rsaKey, signJwt } from './helpers.ts';

test('oidc passes IdentityPort conformance', async () => {
  const key = rsaKey('k1');
  const p = await idp([key]);
  try {
    const claims = { iss: p.issuer, aud: 'agent-runtime', sub: 'alice', exp: nowSec() + 300 };
    const valid = signJwt(key, claims);
    const report = await checkAdapter(identityAdapter, {
      options: { issuer: p.issuer, audience: 'agent-runtime' },
      fixtures: {
        valid, expectSubject: 'alice',
        invalid: ['', 'not-a-credential', `${b64({ alg: 'none' })}.${b64(claims)}.`, signJwt(key, { ...claims, exp: nowSec() - 3600 }), signJwt(key, { ...claims, aud: 'other' })],
      },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await p.close();
  }
});

test('oidc passes CredentialPort conformance', async () => {
  const p = await idp([]);
  p.routes['/token'] = json(200, { access_token: 'agent-token', token_type: 'Bearer', expires_in: 300 });
  try {
    const report = await checkAdapter(credentialAdapter, { options: { issuer: p.issuer, clientId: 'agent-runtime', clientSecret: 'test-secret', mode: 'self' } });
    assert.deepEqual(report.failures, []);
  } finally {
    await p.close();
  }
});

test('descriptors refuse incomplete options', async () => {
  const report = await checkAdapter(identityAdapter, { options: { issuer: 'https://idp.example.com' } });
  assert.match(report.failures.join('\n'), /audience/);
});
