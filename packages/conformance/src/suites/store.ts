import type { JsonValue, StorePort } from '@agent-layers/core';
import { Checks } from '../check.ts';
import { conforms } from '../schemas.ts';

export interface StoreFixtures {
  /** Largest value the instance accepts, in bytes of JSON (default 65536, the default of the adapters in this repository). */
  maxValueBytes?: number;
  /** Time to live of the expiry check (default 20 ms); the check then waits four times as long. */
  ttlMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * StorePort: versions, compare-and-set, delete, expiry, listing, isolation of keys, copies in and out, and the value
 * size limit. Keys live under a fresh `conformance.<run>/` prefix and are deleted at the end.
 */
export async function checkStore(port: StorePort, f: StoreFixtures = {}, c = new Checks()): Promise<Checks> {
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ns = `conformance.${run}/`;
  const key = `${ns}a`;
  const written = new Set<string>();
  const set = (label: string, k: string, v: JsonValue, o?: Parameters<StorePort['set']>[2]) => { written.add(k); return c.attempt(label, () => port.set(k, v, o)); };

  c.expect((await c.attempt('get unknown', () => port.get(`${ns}missing`))) === undefined, 'get: an unknown key must resolve to undefined');

  // Values are copies: changing what was written or what was read never changes the store.
  const input = { n: 1, list: [1, 'x', null, true], nested: { s: 'é' } };
  const first = await set('set', key, input);
  if (!first?.ok) { c.expect(false, 'set: a write without ifVersion must succeed'); return c; }
  c.expect(Number.isSafeInteger(first.version) && first.version >= 1, 'set: version must be an integer >= 1');
  input.n = 2;
  const read = await c.attempt('get', () => port.get(key));
  if (read) {
    c.all(conforms('store-entry', read), 'store entry');
    c.expect(same(read.value, { n: 1, list: [1, 'x', null, true], nested: { s: 'é' } }), 'get: must return the value as written, not the caller\'s later changes');
    c.expect(read.version === first.version, 'get: version must be the one set returned');
    (read.value as { n: number }).n = 3;
    c.expect((await c.attempt('get again', () => port.get(key)) as { value: { n: number } } | undefined)?.value.n === 1, 'get: the value returned must be a copy');
  }

  // Versions grow; compare-and-set refuses a stale version and reports the current one.
  const second = await set('set again', key, { n: 2 });
  const v2 = second?.ok ? second.version : 0;
  c.expect(v2 > first.version, 'set: every write must increase the version');
  const stale = await set('set stale', key, { n: 9 }, { ifVersion: first.version });
  c.expect(stale && !stale.ok && stale.version === v2, 'set: ifVersion with a stale version must be a conflict naming the current version');
  c.expect(same((await c.attempt('get after conflict', () => port.get(key)))?.value, { n: 2 }), 'set: a conflict must not change the value');
  const third = await set('set ifVersion', key, { n: 3 }, { ifVersion: v2 });
  const v3 = third?.ok ? third.version : 0;
  c.expect(third?.ok && v3 > v2, 'set: ifVersion with the current version must succeed with a newer version');
  const exists = await set('set ifVersion 0 on a key', key, { n: 0 }, { ifVersion: 0 });
  c.expect(exists && !exists.ok && exists.version === v3, 'set: ifVersion 0 on an existing key must be a conflict');
  const created = await set('set ifVersion 0 on no key', `${ns}b`, 'b', { ifVersion: 0 });
  c.expect(created?.ok, 'set: ifVersion 0 on an absent key must create it');
  const raced = await Promise.all([port.set(key, { n: 4 }, { ifVersion: v3 }), port.set(key, { n: 5 }, { ifVersion: v3 })]).catch(() => undefined);
  c.expect(raced?.filter((r) => r.ok).length === 1, 'set: of two concurrent writes with the same ifVersion exactly one must succeed');
  const current = (await c.attempt('get after race', () => port.get(key)))?.version ?? 0;

  // Delete: compare-and-set too; versions are never reused after it.
  const refused = await c.attempt('delete stale', () => port.delete(key, { ifVersion: v2 }));
  c.expect(refused && !refused.ok && refused.version === current, 'delete: ifVersion with a stale version must be a conflict naming the current version');
  c.expect((await c.attempt('get after refused delete', () => port.get(key))) !== undefined, 'delete: a conflict must keep the key');
  const deleted = await c.attempt('delete', () => port.delete(key, { ifVersion: current }));
  c.expect(deleted?.ok && deleted.existed, 'delete: must remove an existing key');
  c.expect((await c.attempt('get deleted', () => port.get(key))) === undefined, 'delete: the key must read as absent');
  const again = await c.attempt('delete absent', () => port.delete(key));
  c.expect(again?.ok && !again.existed, 'delete: an absent key must succeed with existed false');
  const reborn = await set('set after delete', key, 'again', { ifVersion: 0 });
  c.expect(reborn?.ok && reborn.version > current, 'set: a key written after a delete must get a newer version than before');

  // Expiry: an expired key reads as absent, everywhere.
  const ttlMs = f.ttlMs ?? 20;
  const ttlKey = `${ns}ttl`;
  const ttl = await set('set with ttlMs', ttlKey, 1, { ttlMs });
  const withTtl = await c.attempt('get with ttl', () => port.get(ttlKey));
  c.expect(ttl?.ok && typeof withTtl?.expiresAt === 'string', 'set: ttlMs must give the entry an expiresAt');
  await sleep(ttlMs * 4);
  c.expect((await c.attempt('get expired', () => port.get(ttlKey))) === undefined, 'ttl: an expired key must read as absent');
  c.expect((await set('set ifVersion 0 on expired', ttlKey, 2, { ifVersion: 0 }))?.ok, 'ttl: an expired key must count as absent for ifVersion 0');

  // Invalid input rejects; it is never a conflict.
  for (const bad of ['no-namespace', 'Upper.case', 'conformance.with space', '']) await c.rejects(`set key ${JSON.stringify(bad)}`, () => port.set(bad, 1));
  for (const [label, value] of [['undefined', undefined], ['NaN', Number.NaN], ['a function', () => 1], ['a Date', new Date(0)]] as const) {
    await c.rejects(`set ${label}`, () => port.set(`${ns}bad`, value as unknown as JsonValue));
  }
  await c.rejects('set ifVersion -1', () => port.set(`${ns}bad`, 1, { ifVersion: -1 }));
  await c.rejects('set ttlMs 0', () => port.set(`${ns}bad`, 1, { ttlMs: 0 }));
  const max = f.maxValueBytes ?? 65_536;
  c.expect((await set('set at the size limit', `${ns}big`, 'x'.repeat(max - 2)))?.ok, `size: a value of ${max} bytes must be accepted`);
  await c.rejects('set over the size limit', () => port.set(`${ns}big`, 'x'.repeat(max - 1)));

  // Isolation: another namespace, or a longer key with the same start, is another key.
  const other = `conformance-other.${run}/a`;
  await set('set in another namespace', other, 'other');
  c.expect(same((await c.attempt('get after other namespace', () => port.get(key)))?.value, 'again'), 'isolation: a key in another namespace must not change this one');
  await set('set a longer key', `${ns}ab`, 'ab');
  c.expect(same((await c.attempt('get after longer key', () => port.get(key)))?.value, 'again'), 'isolation: a longer key must not change this one');

  if (port.list) {
    const keys = await c.attempt('list', () => port.list!(ns));
    const names = keys?.map((k) => k.key) ?? [];
    c.expect(same(names, [...names].sort()), 'list: keys must be in key order');
    c.expect([key, `${ns}ab`, `${ns}b`].every((k) => names.includes(k)), 'list: must return the keys with the prefix');
    c.expect(names.every((k) => k.startsWith(ns)), 'list: must return only keys with the prefix');
    c.expect(!names.includes(`${ns}missing`) && keys?.every((k) => Number.isSafeInteger(k.version) && k.version >= 1), 'list: entries must carry their version');
    c.expect((await c.attempt('list limit', () => port.list!(ns, { limit: 1 })))?.length === 1, 'list: must respect limit');
    const after = await c.attempt('list after', () => port.list!(ns, { after: key }));
    c.expect(!!after && after.every((k) => k.key > key) && after.some((k) => k.key === `${ns}ab`), 'list: after must return only later keys');
  } else c.skip('list: optional, not implemented');

  for (const k of written) await port.delete(k).catch(() => {});
  return c;
}
