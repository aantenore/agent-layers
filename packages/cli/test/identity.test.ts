import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, defineAdapter, PORT_VERSIONS, type IdentityPort, type ResolvedConfig } from '@agent-layers/core';
import { resolveToken, TOKEN_ENV } from '../src/identity.ts';

const identity = (name: string, devCredential?: (o: { tokens?: Record<string, unknown> }) => string | undefined) => defineAdapter<'IdentityPort', { tokens?: Record<string, unknown> }>({
  layer: 'identity', port: 'IdentityPort', name, direction: 'outbound', maps: { technology: 'test table' },
  portVersion: PORT_VERSIONS.IdentityPort, tiers: ['prototype', 'production'], optionsSchema: { type: 'object' },
  ...(devCredential ? { devCredential } : {}),
  create: (): IdentityPort => ({ name, verify: async () => { throw new Error('invalid credential'); } }),
});

const registry = new AdapterRegistry().register([
  identity('table', (o) => Object.keys(o.tokens ?? {})[0]),
  identity('remote'),
]);
const project = (tier: string, adapter: string, env: Record<string, string> = {}) => ({
  config: { tier, layers: { identity: { adapter, options: { tokens: { 'dev-token': {} } } } } } as unknown as ResolvedConfig,
  env,
  registry,
});

test('the identity adapter offers the default caller through devCredential, on a prototype profile only', async () => {
  assert.equal(await resolveToken(project('prototype', 'table')), 'dev-token');
  assert.equal(await resolveToken(project('production', 'table')), undefined);
  assert.equal(await resolveToken(project('prototype', 'remote')), undefined, 'an adapter without the hook offers none');
  assert.equal(await resolveToken(project('prototype', 'not-installed')), undefined, 'an unknown adapter offers none');
});

test('--token, then AGENT_LAYERS_TOKEN, come before the development credential', async () => {
  assert.equal(await resolveToken(project('prototype', 'table', { [TOKEN_ENV]: 'env-token' })), 'env-token');
  assert.equal(await resolveToken(project('prototype', 'table', { [TOKEN_ENV]: 'env-token' }), 'flag-token'), 'flag-token');
  assert.equal(await resolveToken(project('production', 'remote', { [TOKEN_ENV]: 'env-token' })), 'env-token');
});
