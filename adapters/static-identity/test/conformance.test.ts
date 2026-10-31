import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { credentialAdapter, identityAdapter } from '../src/index.ts';

test('static-identity passes IdentityPort conformance', async () => {
  const report = await checkAdapter(identityAdapter, {
    options: { tokens: { 'dev-token': { subject: 'alice', roles: ['staff'] } } },
    fixtures: { valid: 'dev-token', expectSubject: 'alice', invalid: ['', 'nope'] },
  });
  assert.deepEqual(report.failures, []);
});

test('static-identity passes CredentialPort conformance', async () => {
  const report = await checkAdapter(credentialAdapter, { options: { tokens: { conformance: 'tok' } } });
  assert.deepEqual(report.failures, []);
});
