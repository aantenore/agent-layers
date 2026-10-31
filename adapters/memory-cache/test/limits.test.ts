import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry, type CachePort } from '@agent-layers/core';
import { adapter } from '../src/index.ts';

const ctx = { name: 'cache', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const make = (options: Record<string, unknown>) => new AdapterRegistry().register(adapter).create('CachePort', 'memory-cache', options, ctx) as Promise<CachePort>;

test('maxEntries and ttlMs take effect when set (numeric strings, as from ${env:...})', async () => {
  const cache = await make({ maxEntries: '2', ttlMs: '30' });
  await cache.set('a', 1);
  await cache.set('b', 2);
  await cache.set('c', 3);
  assert.equal(await cache.get('a'), undefined, 'the least recently used entry is evicted at 2');
  assert.equal(await cache.get('c'), 3);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await cache.get('c'), undefined, 'expired after the default ttl');
});

test('"unbounded" means no cap and no expiry', async () => {
  const cache = await make({ maxEntries: 'unbounded', ttlMs: 'unbounded' });
  for (let i = 0; i < 1500; i++) await cache.set(`k${i}`, i);
  assert.equal(await cache.get('k0'), 0);
});

test('out-of-range values are rejected', async () => {
  await assert.rejects(make({ maxEntries: 0 }), /maxEntries/);
  await assert.rejects(make({ ttlMs: 0 }), /ttlMs/);
  await assert.rejects(make({ maxEntries: 'many' }), /maxEntries/);
});
