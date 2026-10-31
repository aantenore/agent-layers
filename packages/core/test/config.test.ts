import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ConfigError, configSchema, interpolate, parseAgentFile, parseConfig, resolveProfile, type StackConfig } from '../src/index.ts';

test('interpolates ${env:X} and ${env:X:-default}, reporting missing variables', () => {
  const errors: string[] = [];
  const out = interpolate({ a: '${env:A}/v1', b: ['${env:B:-fallback}'], c: '${env:C}' }, { A: 'http://h' }, errors);
  assert.deepEqual(out, { a: 'http://h/v1', b: ['fallback'], c: '' });
  assert.deepEqual(errors, ['$.c: environment variable C is not set']);
});

test('schema rejects unknown slots and malformed refs', () => {
  assert.throws(() => parseConfig(JSON.stringify({ layers: { modle: { adapter: 'x' } } })), (e: unknown) => e instanceof ConfigError && /layers\.modle: unknown property/.test(e.message));
  assert.throws(() => parseConfig(JSON.stringify({ layers: { model: { options: {} } } })), /layers\.model/);
  assert.throws(() => parseConfig('{ nope'), /not valid JSON/);
});

const ladder: StackConfig = {
  layers: { model: { adapter: 'mock-model' } },
  profiles: {
    prototype: { tier: 'prototype', layers: { telemetry: [{ adapter: 'console-telemetry' }], knowledge: { docs: { adapter: 'markdown-knowledge', options: { dir: 'k' } } } } },
    pilot: { extends: 'prototype', layers: { telemetry: [{ adapter: 'otlp' }], knowledge: { docs: { adapter: 'qdrant' } } } },
    production: {
      extends: 'pilot', tier: 'production',
      layers: { model: { adapter: 'openai-compatible', options: { baseUrl: '${env:GATEWAY_URL}' } }, telemetry: { $merge: 'append', items: [{ adapter: 'jsonl-telemetry' }] }, knowledge: { extra: { adapter: 'sql' } } },
    },
  },
};

test('profiles resolve along the extends chain', () => {
  const p = resolveProfile(ladder, 'production');
  assert.deepEqual(p.chain, ['prototype', 'pilot', 'production']);
  assert.equal(p.tier, 'production');
  assert.equal(p.layers.model?.adapter, 'openai-compatible');
  assert.deepEqual((p.layers.telemetry as { adapter: string }[]).map((t) => t.adapter), ['otlp', 'jsonl-telemetry']);
  assert.deepEqual(Object.keys(p.layers.knowledge!), ['docs', 'extra']);
  assert.equal(p.layers.knowledge!.docs!.adapter, 'qdrant');
  assert.equal(p.layers.knowledge!.docs!.options, undefined, 'an entry that switches adapter drops the old options');
  const same = resolveProfile({ layers: { knowledge: { d: { adapter: 'md', options: { dir: 'a', k: 2 } } } }, profiles: { x: { layers: { knowledge: { d: { options: { k: 5 } } } } } } }, 'x');
  assert.deepEqual(same.layers.knowledge!.d!.options, { dir: 'a', k: 5 }, 'same adapter: options deep-merge');
  const pilot = resolveProfile(ladder, 'pilot');
  assert.equal(pilot.tier, 'prototype');
  assert.deepEqual((pilot.layers.telemetry as { adapter: string }[]).map((t) => t.adapter), ['otlp'], 'lists replace by default');
});

test('null removes a slot; cycles and unknown profiles are config errors', () => {
  const p = resolveProfile({ layers: { model: { adapter: 'a' }, cache: { adapter: 'c' } }, profiles: { x: { layers: { cache: null } } } }, 'x');
  assert.equal(p.layers.cache, undefined);
  assert.throws(() => resolveProfile({ profiles: { a: { extends: 'b' }, b: { extends: 'a' } } }, 'a'), /extends cycle/);
  assert.throws(() => resolveProfile({ profiles: {} }, 'ghost'), /profiles\.ghost: not defined/);
});

test('env is interpolated only for the selected profile', () => {
  const text = JSON.stringify(ladder);
  assert.doesNotThrow(() => parseConfig(text, { profile: 'pilot', env: {} }));
  assert.throws(() => parseConfig(text, { profile: 'production', env: {} }), /GATEWAY_URL is not set \(profile production\)/);
  assert.equal(parseConfig(text, { env: { AGENT_LAYERS_PROFILE: 'production', GATEWAY_URL: 'http://gw/v1' } }).layers.model?.options?.baseUrl, 'http://gw/v1');
});

test('agent files: front matter plus instructions', () => {
  const a = parseAgentFile('---\nmodel: mock\ntools: [docs__search, "util__*"]\n---\nYou help.\n');
  assert.deepEqual(a, { model: 'mock', tools: ['docs__search', 'util__*'], instructions: 'You help.' });
});

test('published JSON Schemas are in sync with the TypeScript definition', () => {
  const expected = `${JSON.stringify(configSchema, null, 2)}\n`;
  for (const f of ['../schema/agent-layers.schema.json', '../../../spec/schemas/stack-config.json']) {
    assert.equal(readFileSync(new URL(f, import.meta.url), 'utf8'), expected, `${f} is stale: run npm run gen:schema`);
  }
});

test('policy rules accept when.authenticated in the base config and in profiles', () => {
  const rules = [{ effect: 'allow', risk: ['read'], when: { authenticated: true } }, { effect: 'deny' }];
  const c = parseConfig(JSON.stringify({ policy: rules, profiles: { p: { policy: rules } } }), { profile: 'p' });
  assert.deepEqual(c.policy, rules);
  assert.throws(() => parseConfig(JSON.stringify({ policy: [{ effect: 'allow', when: { authenticated: 'yes' } }] })), ConfigError);
});
