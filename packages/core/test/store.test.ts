import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, compose, encodeStoreValue, jsonProblem, readiness, resolveProfile, storeKeyProblem, storeOptionsProblem, type StorePort } from '../src/index.ts';
import { testAdapter } from './helpers.ts';

const store = (): StorePort => ({ get: async () => undefined, set: async () => ({ ok: true, version: 1 }), delete: async () => ({ ok: true, existed: false }) });

test('layers.store fills stack.ports.store', async () => {
  const s = await compose(resolveProfile({ layers: { store: { adapter: 'kv' } } }), { adapters: [testAdapter('StorePort', 'harness', 'kv', store)] });
  assert.ok(s.ports.store);
  assert.deepEqual(await s.ports.store.set('app.k', 1), { ok: true, version: 1 });
  await s.close();
});

test('readiness: a prototype-only store is refused on the production tier; the store is not required', async () => {
  const registry = new AdapterRegistry().register(testAdapter('StorePort', 'harness', 'kv', store)).register(testAdapter('StorePort', 'harness', 'durable-kv', store, ['prototype', 'production']));
  const production = (adapter: string) => resolveProfile({ layers: { store: { adapter } }, profiles: { p: { tier: 'production', requires: [] } } }, 'p');
  assert.deepEqual((await readiness(production('kv'), registry)).problems.map((p) => [p.kind, p.slot]), [['prototype-only', 'store']]);
  assert.deepEqual((await readiness(production('durable-kv'), registry)).problems, []);
  const defaults = resolveProfile({ layers: {}, profiles: { p: { tier: 'production' } } }, 'p');
  assert.ok(!(await readiness(defaults, registry)).problems.some((p) => p.slot === 'store'));
});

test('store helpers: keys, JSON values, size and write options', () => {
  assert.equal(storeKeyProblem('plexus.state/sess-1:step', 512), undefined);
  for (const bad of ['nodot', 'Upper.x', '.x', 'a.', 'a. b', 'a.é', 5]) assert.ok(storeKeyProblem(bad, 512), String(bad));
  assert.match(storeKeyProblem('app.0123456789', 10)!, /longer than 10/);
  assert.equal(jsonProblem({ a: [1, 'x', null, true, { b: -0.5 }] }), undefined);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const [v, msg] of [[undefined, /not JSON/], [Number.POSITIVE_INFINITY, /finite/], [new Map(), /plain object/], [cycle, /circular/], [{ f: () => 1 }, /value\.f/]] as const) {
    assert.match(jsonProblem(v)!, msg);
  }
  const shared = { n: 1 };
  assert.equal(jsonProblem([shared, shared]), undefined, 'a value seen twice is not a cycle');
  assert.deepEqual(encodeStoreValue('é', 4), { json: '"é"' });
  assert.match((encodeStoreValue('é', 3) as { problem: string }).problem, /4 bytes, larger than 3/);
  assert.equal(storeOptionsProblem({ ifVersion: 0, ttlMs: 1 }), undefined);
  assert.ok(storeOptionsProblem({ ifVersion: 1.5 }));
  assert.ok(storeOptionsProblem({ ttlMs: 0 }));
});
