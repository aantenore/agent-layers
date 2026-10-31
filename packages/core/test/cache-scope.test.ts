import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AdapterRegistry, compose, messageText, readiness, replyText, resolveProfile, textMessage,
  type CachePort, type Caller, type KnowledgePort, type StackConfig,
} from '../src/index.ts';
import { fakeModel, reply, testAdapter } from './helpers.ts';

const alice: Caller = { id: 'alice', kind: 'user', roles: [], scopes: [] };
const bob: Caller = { id: 'bob', kind: 'user', roles: [], scopes: [] };

/** Knowledge filtered by caller: each caller sees only their own passage. */
const privateNotes: KnowledgePort = {
  search: async (q) => [{ id: q.caller?.id ?? 'none', source: 'notes', text: `private note of ${q.caller?.id ?? 'nobody'}` }],
};

function memoryCache(): CachePort & { keys: Set<string> } {
  const m = new Map<string, unknown>();
  return { keys: new Set(), get: async (k) => m.get(k), async set(k, v) { this.keys.add(k); m.set(k, v); } };
}

/** A stack with caller-scoped knowledge and a cache; the model repeats the knowledge block it received. */
async function stack(cacheScope?: 'caller' | 'shared') {
  const cache = memoryCache();
  const { model, requests } = fakeModel((req) => reply(req.messages.map((m) => messageText(m)).join('\n')));
  const config: StackConfig = {
    layers: { model: { adapter: 'fake' }, cache: { adapter: 'cache' }, knowledge: { notes: { adapter: 'notes' } } },
    ...(cacheScope ? { pipeline: { cacheScope } } : {}),
    agents: { a: { model: 'm' } },
  };
  const s = await compose(resolveProfile(config), {
    adapters: [
      testAdapter('ModelPort', 'llm', 'fake', () => model),
      testAdapter('CachePort', 'cache', 'cache', () => cache),
      testAdapter('KnowledgePort', 'knowledge', 'notes', () => privateNotes),
    ],
  });
  const ask = async (caller: Caller | undefined) =>
    replyText(await s.model.chat({ model: 'm', messages: [textMessage('user', 'What do my notes say?')] }, s.context({ agent: 'a', ...(caller ? { caller } : {}) })));
  return { s, ask, requests, cache };
}

test('cache scope caller (default): the same question from two callers never shares an answer', async () => {
  const { s, ask, requests, cache } = await stack();
  const a1 = await ask(alice);
  const b1 = await ask(bob);
  assert.match(a1, /private note of alice/);
  assert.match(b1, /private note of bob/);
  assert.doesNotMatch(b1, /alice/, 'bob is never served alice\'s cached answer');
  assert.equal(requests.length, 2);
  assert.equal(await ask(alice), a1, 'the same caller still hits the cache');
  assert.equal(requests.length, 2);
  await ask(undefined);
  assert.equal(requests.length, 3, 'an anonymous call has its own entry');
  assert.equal(cache.keys.size, 3);
  await s.close();
});

test('cache scope shared: one entry for every caller (the leak the default prevents)', async () => {
  const { s, ask, requests } = await stack('shared');
  await ask(alice);
  const b = await ask(bob);
  assert.equal(requests.length, 1);
  assert.match(b, /private note of alice/);
  await s.close();
});

test('check on production warns about a shared cache with knowledge sources', async () => {
  const registry = new AdapterRegistry().register([
    testAdapter('CachePort', 'cache', 'cache', () => ({}), ['production']),
    testAdapter('KnowledgePort', 'knowledge', 'notes', () => ({}), ['production']),
  ]);
  const config = (pipeline: StackConfig['pipeline'], knowledge = true, tier: 'production' | 'prototype' = 'production'): StackConfig => ({
    profiles: {
      p: {
        tier, requires: [],
        layers: { cache: { adapter: 'cache' }, ...(knowledge ? { knowledge: { notes: { adapter: 'notes' } } } : {}) },
        ...(pipeline ? { pipeline } : {}),
      },
    },
  });
  const warns = async (c: StackConfig) => (await readiness(resolveProfile(c, 'p'), registry)).warnings.filter((w) => w.includes('cacheScope'));
  assert.equal((await warns(config({ cacheScope: 'shared' }))).length, 1);
  assert.deepEqual(await warns(config(undefined)), []);
  assert.deepEqual(await warns(config({ cacheScope: 'caller' })), []);
  assert.deepEqual(await warns(config({ cacheScope: 'shared' }, false)), [], 'no knowledge, nothing to leak');
  assert.deepEqual(await warns(config({ cacheScope: 'shared' }, true, 'prototype')), []);
});
