import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, diffProfiles, formatDiff, readiness, resolveProfile, type StackConfig } from '../src/index.ts';
import { testAdapter } from './helpers.ts';

const registry = () => new AdapterRegistry().register([
  testAdapter('ModelPort', 'llm', 'mock-model', () => ({})),
  testAdapter('ModelPort', 'llm', 'gateway', () => ({}), ['production']),
  testAdapter('IdentityPort', 'identity', 'static-identity', () => ({})),
  testAdapter('IdentityPort', 'identity', 'oidc', () => ({}), ['production']),
  testAdapter('TelemetryPort', 'telemetry', 'console-telemetry', () => ({}), ['prototype']),
]);

const config: StackConfig = {
  profiles: {
    prototype: { layers: { model: { adapter: 'mock-model' }, identity: { adapter: 'static-identity' }, telemetry: [{ adapter: 'console-telemetry' }] } },
    production: { extends: 'prototype', tier: 'production', layers: { model: { adapter: 'gateway' }, guardrails: [{ adapter: 'presidio' }] } },
    strict: { extends: 'production', requires: ['identity'], layers: { identity: { adapter: 'oidc' }, telemetry: null, guardrails: null } },
  },
};

test('prototype tier passes with prototype adapters', async () => {
  const r = await readiness(resolveProfile(config, 'prototype'), registry());
  assert.equal(r.ok, true);
  assert.deepEqual(r.requires, []);
});

test('production tier rejects prototype-only adapters, missing slots and missing packages', async () => {
  const r = await readiness(resolveProfile(config, 'production'), registry());
  assert.equal(r.ok, false);
  const kinds = r.problems.map((p) => `${p.kind}:${p.slot}`);
  assert.ok(kinds.includes('prototype-only:identity'));
  assert.ok(kinds.includes('prototype-only:telemetry'));
  assert.ok(kinds.includes('not-installed:guardrails'));
  assert.ok(kinds.includes('missing-layer:authorization'));
  assert.ok(kinds.includes('missing-layer:state'));
  assert.ok(!kinds.includes('prototype-only:model'));
  assert.match(r.problems.find((p) => p.kind === 'not-installed')!.message, /adapter "presidio" is not installed/);
});

test('requires is configurable per profile', async () => {
  const r = await readiness(resolveProfile(config, 'strict'), registry());
  assert.deepEqual(r.requires, ['identity']);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test('diff reports same, changed, added and removed per slot', () => {
  const rows = diffProfiles(resolveProfile(config, 'prototype'), resolveProfile(config, 'production'));
  const by = Object.fromEntries(rows.map((r) => [r.slot, r]));
  assert.equal(by.model!.status, 'changed');
  assert.equal(by.model!.from, 'mock-model');
  assert.equal(by.model!.to, 'gateway');
  assert.equal(by.identity!.status, 'same');
  assert.equal(by.guardrails!.status, 'added');
  const removed = diffProfiles(resolveProfile(config, 'production'), resolveProfile(config, 'strict'));
  assert.equal(removed.find((r) => r.slot === 'telemetry')!.status, 'removed');
  const text = formatDiff(rows, 'prototype', 'production');
  assert.match(text, /^prototype → production/);
  assert.match(text, /model\s+changed\s+mock-model → gateway/);
  assert.match(text, /guardrails\s+added\s+presidio/);
});
