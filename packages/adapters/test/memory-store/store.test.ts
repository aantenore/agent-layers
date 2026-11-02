import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, limitFindings, limitList, noopTelemetry, type StorePort } from '@agent-layers/core';
import { adapter, createMemoryStore, LIMITS } from '../../src/memory-store/index.ts';

const ctx = { name: 'store', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const make = (options: Record<string, unknown>) => new AdapterRegistry().register(adapter).create('StorePort', 'memory-store', options, ctx) as Promise<StorePort>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('versions come from one counter: a key never gets a version it had before', async () => {
  const store = createMemoryStore();
  const a = await store.set('app.a', 1);
  const b = await store.set('app.b', 1);
  assert.ok(a.ok && b.ok && b.version > a.version);
  await store.delete('app.a');
  const again = await store.set('app.a', 2);
  assert.ok(again.ok && b.ok && again.version > b.version);
});

test('maxKeys refuses a new key once expired keys are dropped; existing keys can still be written', async () => {
  const store = createMemoryStore({ maxKeys: 2 });
  await store.set('app.a', 1);
  await store.set('app.b', 1, { ttlMs: 5 });
  await sleep(20);
  assert.ok((await store.set('app.c', 1)).ok, 'the expired key makes room');
  await assert.rejects(store.set('app.d', 1), /full/);
  assert.ok((await store.set('app.a', 2)).ok);
});

test('maxValueBytes and maxKeyChars bound what is stored', async () => {
  const store = createMemoryStore({ maxValueBytes: 1024, maxKeyChars: 16 });
  assert.ok((await store.set('app.k', 'x'.repeat(1022))).ok);
  await assert.rejects(store.set('app.k', 'x'.repeat(1023)), /larger than 1024/);
  await assert.rejects(store.set('app.0123456789abc', 1), /longer than 16/);
});

test('list is capped by listLimit and pages with after', async () => {
  const store = createMemoryStore({ listLimit: 2 });
  for (const k of ['c', 'a', 'b']) await store.set(`app.${k}`, k);
  const first = await store.list!('app.', { limit: 10 });
  assert.deepEqual(first.map((k) => k.key), ['app.a', 'app.b']);
  assert.deepEqual((await store.list!('app.', { after: 'app.b' })).map((k) => k.key), ['app.c']);
});

test('limits: defaults, numeric strings, invalid values and production findings', async () => {
  assert.deepEqual([LIMITS.maxKeys.default, LIMITS.maxKeyChars.default, LIMITS.maxValueBytes.default, LIMITS.listLimit.default], [10_000, 512, 65_536, 100]);
  const store = await make({ maxKeys: '1' });
  await store.set('app.a', 1);
  await assert.rejects(store.set('app.b', 1), /full/);
  await assert.rejects(make({ maxValueBytes: 10 }), /maxValueBytes/);
  await assert.rejects(make({ listLimit: 0 }), /listLimit/);
  const specs = limitList(LIMITS);
  assert.deepEqual(limitFindings(specs, { options: {} }, 'production'), []);
  assert.deepEqual(limitFindings(specs, { options: { maxKeys: 'unbounded' } }, 'production').map((f) => [f.path, f.severity]), [['options.maxKeys', 'warn']]);
});
