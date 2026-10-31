import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineAdapter, PORT_VERSIONS, type CachePort, type GuardPort, type KnowledgePort, type ToolPort } from '@agent-layers/core';
import { checkAdapter, checkDescriptor, conformance } from '../src/index.ts';

const goodCache = (): CachePort => {
  const m = new Map<string, { v: unknown; until: number }>();
  return {
    get: async (k) => { const e = m.get(k); return e && e.until > Date.now() ? structuredClone(e.v) : undefined; },
    set: async (k, v, o) => { m.set(k, { v: structuredClone(v), until: o?.ttlMs ? Date.now() + o.ttlMs : Infinity }); },
    delete: async (k) => { m.delete(k); },
  };
};

test('a correct implementation passes', async () => {
  assert.deepEqual((await conformance('CachePort', goodCache())).failures, []);
});

test('broken implementations are caught with readable failures', async () => {
  const leaky: CachePort = { get: async () => 'always', set: async () => {} };
  const r = await conformance('CachePort', leaky);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.includes('missing key must resolve to undefined')));

  const throwing: ToolPort = { listTools: async () => [{ name: 'bad name!', description: 'x', inputSchema: {} }], callTool: async () => { throw new Error('nope'); } };
  const t = await conformance('ToolPort', throwing);
  assert.ok(t.failures.some((f) => f.includes('tool[0]')));
  assert.ok(t.failures.some((f) => f.includes('callTool unknown: threw nope')));

  const bad: KnowledgePort = { search: async () => [{ id: 1, body: 'x' } as never, { id: '2', text: 'y' }, { id: '3', text: 'z' }] };
  const k = await conformance('KnowledgePort', bad);
  assert.ok(k.failures.some((f) => f.startsWith('passage[0]')));
  assert.ok(k.failures.some((f) => f.includes('must respect k')));

  const sloppy: GuardPort = { check: async () => ({ action: 'redact' }) };
  const g = await conformance('GuardPort', sloppy, { block: [{ stage: 'input', text: 'x' }] });
  assert.ok(g.failures.some((f) => f.includes('verdict')));
  assert.ok(g.failures.some((f) => f.includes('block: input sample got redact')));
});

test('checkAdapter checks the descriptor and closes the instance', async () => {
  let closed = false;
  const d = defineAdapter({
    layer: 'cache', port: 'CachePort', name: 'test-cache', direction: 'outbound', maps: { technology: 'map' },
    portVersion: PORT_VERSIONS.CachePort, tiers: ['prototype'], create: () => ({ ...goodCache(), close: async () => { closed = true; } }),
  });
  const r = await checkAdapter(d);
  assert.deepEqual(r.failures, ['optionsSchema is missing']);
  assert.ok(closed);
  assert.deepEqual(checkDescriptor({ ...d, optionsSchema: {} }), []);
});
