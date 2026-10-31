import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterError, AdapterRegistry, defineAdapter, noopTelemetry, PORT_VERSIONS, PORTS, type AnyAdapter } from '../src/index.ts';
import { testAdapter } from './helpers.ts';

const ctx = { name: 'x', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };

test('PORT_VERSIONS covers every port and each port names its layer', () => {
  assert.equal(Object.keys(PORT_VERSIONS).length, 21);
  for (const p of Object.values(PORTS)) assert.match(PORT_VERSIONS[p.port], /^\d+\.\d+\.\d+$/);
  assert.equal(PORTS.TriggerPort.layer, 'interface');
  assert.equal(PORTS.ApprovalPort.layer, 'identity');
});

test('defineAdapter rejects inconsistent descriptors', () => {
  const base = { port: 'CachePort', layer: 'cache', name: 'ok', direction: 'outbound', maps: { technology: 'x' }, portVersion: PORT_VERSIONS.CachePort, tiers: ['prototype'], create: () => ({}) } as const;
  assert.doesNotThrow(() => defineAdapter(base as never));
  assert.throws(() => defineAdapter({ ...base, layer: 'llm' } as never), /belongs to layer cache/);
  assert.throws(() => defineAdapter({ ...base, maps: {} } as never), /standard or a technology/);
  assert.throws(() => defineAdapter({ ...base, portVersion: '9.0.0' } as never), /implements CachePort 9\.0\.0/);
  assert.throws(() => defineAdapter({ ...base, tiers: [] } as never), /tiers/);
  assert.throws(() => defineAdapter({ ...base, name: 'Bad Name' } as never), /kebab-case/);
  assert.throws(() => defineAdapter({ ...base, port: 'NopePort' } as never), /unknown port/);
});

test('registry registers, lists, and validates options with layer and adapter in the error', async () => {
  const a = { ...testAdapter('CachePort', 'cache', 'mem', (o) => ({ o, get: async () => undefined, set: async () => {} })), optionsSchema: { type: 'object', properties: { size: { type: 'integer' } }, additionalProperties: false } } as AnyAdapter;
  const r = new AdapterRegistry().register(a);
  assert.throws(() => r.register(a), /already registered/);
  assert.equal(r.list({ layer: 'cache' }).length, 1);
  assert.equal(r.list({ port: 'ModelPort' }).length, 0);
  const inst = await r.create('CachePort', 'mem', { size: 3 }, ctx) as unknown as { o: unknown };
  assert.deepEqual(inst.o, { size: 3 });
  await assert.rejects(r.create('CachePort', 'mem', { size: 'x' }, ctx), (e: unknown) => e instanceof AdapterError && /\[cache\/mem\] invalid options: options\.size: expected integer/.test(e.message));
  await assert.rejects(r.create('CachePort', 'nope', {}, ctx), /\[cache\/nope\] not installed/);
});

test('create failures are wrapped with layer and adapter', async () => {
  const r = new AdapterRegistry().register(testAdapter('ModelPort', 'llm', 'broken', () => { throw new Error('boom'); }));
  await assert.rejects(r.create('ModelPort', 'broken', {}, ctx), /\[llm\/broken\] boom/);
});

test('loader resolves adapters on demand; load errors are surfaced', async () => {
  const lazy = testAdapter('RouterPort', 'cache', 'lazy', () => ({ select: () => 'm' }));
  const calls: string[] = [];
  const r = new AdapterRegistry({ loader: async (_p, name) => { calls.push(name); return name === 'lazy' ? [lazy] : undefined; } });
  assert.ok(await r.resolve('RouterPort', 'lazy'));
  assert.equal(await r.resolve('RouterPort', 'other'), undefined);
  assert.deepEqual(calls, ['lazy', 'other']);
  const failing = new AdapterRegistry({ loader: async () => { throw new SyntaxError('bad module'); } });
  await assert.rejects(failing.resolve('RouterPort', 'x'), /\[cache\/x\] failed to load: bad module/);
});
