import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryCache } from '../src/index.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('evicts the least recently used entry', async () => {
  const cache = createMemoryCache({ maxEntries: 2 });
  await cache.set('a', 1);
  await cache.set('b', 2);
  await cache.get('a');
  await cache.set('c', 3);
  assert.equal(await cache.get('b'), undefined);
  assert.equal(await cache.get('a'), 1);
  assert.equal(await cache.get('c'), 3);
});

test('copies values on set and get', async () => {
  const cache = createMemoryCache();
  const value = { list: [1] };
  await cache.set('k', value);
  value.list.push(2);
  const first = (await cache.get('k')) as typeof value;
  assert.deepEqual(first, { list: [1] });
  first.list.push(3);
  assert.deepEqual(await cache.get('k'), { list: [1] });
});

test('default ttl expires entries and a per-set ttl overrides it', async () => {
  const cache = createMemoryCache({ ttlMs: 30 });
  await cache.set('short', 1);
  await cache.set('long', 2, { ttlMs: 5000 });
  await sleep(80);
  assert.equal(await cache.get('short'), undefined);
  assert.equal(await cache.get('long'), 2);
});

test('delete removes a key', async () => {
  const cache = createMemoryCache();
  await cache.set('k', 1);
  await cache.delete?.('k');
  assert.equal(await cache.get('k'), undefined);
});
