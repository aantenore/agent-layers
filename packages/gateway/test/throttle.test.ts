import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { compose, defineAdapter, PORT_VERSIONS, resolveProfile, type ChannelPort } from '@agent-layers/core';
import { identityAdapter } from '@agent-layers/adapters/static-identity';
import { serveStack, type GatewayOptions } from '../src/index.ts';
import { clientAddress, Concurrency, FixedWindow } from '../src/throttle.ts';

let release: (() => void) | undefined;
const routes = defineAdapter<'ChannelPort'>({
  layer: 'interface', port: 'ChannelPort', name: 'routes', direction: 'inbound', maps: { technology: 'test route' },
  portVersion: PORT_VERSIONS.ChannelPort, tiers: ['prototype', 'production'], optionsSchema: { type: 'object' },
  create: (): ChannelPort => ({
    mount: () => ({
      routes: [
        { path: '/who', methods: ['GET'], handle: async (_req, ctx) => Response.json({ who: ctx.caller?.id ?? null }) },
        { path: '/open', methods: ['GET'], public: true, handle: async () => Response.json({ ok: true }) },
        { path: '/hold', methods: ['GET'], handle: () => new Promise<Response>((resolve) => { release = () => resolve(Response.json({ held: true })); }) },
      ],
    }),
  }),
});

const stackFor = (tier: 'prototype' | 'production') => compose(resolveProfile({
  agents: { a: { model: 'm' } },
  layers: {
    identity: { adapter: 'static-identity', options: { tokens: { 'token-a': { subject: 'alice' }, 'token-b': { subject: 'bob' } } } },
    channels: [{ adapter: 'routes' }],
  },
  profiles: { p: { tier } },
}, 'p'), { adapters: [identityAdapter, routes] });

async function withGateway(tier: 'prototype' | 'production', options: GatewayOptions, run: (url: string) => Promise<void>): Promise<void> {
  const stack = await stackFor(tier);
  const gw = await serveStack(stack, { port: 0, ...options });
  try {
    await run(gw.url);
  } finally {
    release?.();
    release = undefined;
    await gw.close();
    await stack.close();
  }
}

const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const status = async (url: string, init?: RequestInit) => { const r = await fetch(url, init); await r.arrayBuffer(); return r.status; };
const until = async (cond: () => boolean) => { while (!cond()) await sleep(5); };

test('FixedWindow: refuses past the limit, resets with the window, forgets expired and surplus keys', () => {
  let now = 1000;
  const w = new FixedWindow(2, 10_000, () => now, 3);
  assert.equal(w.take('a'), undefined);
  assert.equal(w.blocked('a'), undefined);
  assert.equal(w.take('a'), undefined);
  assert.equal(w.take('a'), 10, 'the third hit waits for the window to end');
  assert.equal(w.take('b'), undefined, 'keys are counted apart');
  now += 4500;
  assert.equal(w.blocked('a'), 6);
  now += 5500;
  assert.equal(w.take('a'), undefined, 'a new window');
  assert.equal(w.size, 1, 'expired keys are dropped');
  for (const k of ['c', 'd', 'e']) w.take(k);
  assert.equal(w.size, 3, 'never more keys than the cap');
  assert.equal(new FixedWindow(Infinity, 1000).take('x'), undefined);
});

test('Concurrency: a cap per key, released once', () => {
  const c = new Concurrency(1);
  const first = c.enter('a');
  assert.ok(first);
  assert.equal(c.enter('a'), undefined);
  assert.ok(c.enter('b'));
  first();
  first();
  assert.ok(c.enter('a'));
  assert.equal(c.enter('a'), undefined, 'a double release frees one slot only');
});

test('clientAddress: the socket unless proxies are trusted, then the entry the last trusted proxy appended', () => {
  assert.equal(clientAddress('10.0.0.1', '6.6.6.6', 0), '10.0.0.1', 'a forged header is ignored by default');
  assert.equal(clientAddress('10.0.0.1', '6.6.6.6, 203.0.113.9', 1), '203.0.113.9');
  assert.equal(clientAddress('10.0.0.1', '6.6.6.6, 203.0.113.9, 10.0.0.2', 2), '203.0.113.9');
  assert.equal(clientAddress('10.0.0.1', undefined, 1), '10.0.0.1');
  assert.equal(clientAddress('10.0.0.1', '203.0.113.9', 2), '10.0.0.1', 'fewer entries than trusted proxies');
});

test('maxInflight: requests past the cap get 503 with Retry-After; health stays reachable; the slot frees with the answer', async () => {
  await withGateway('production', { maxInflight: 1 }, async (url) => {
    const first = fetch(`${url}/hold`, as('token-a'));
    await until(() => !!release);
    const refused = await fetch(`${url}/who`, as('token-b'));
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get('retry-after'), '1');
    assert.equal((await refused.json() as { error: { type: string } }).error.type, 'unavailable');
    assert.equal(await status(`${url}/healthz`), 200);
    release!();
    assert.equal((await first).status, 200);
    await (await first).arrayBuffer();
    await sleep(20);
    assert.equal(await status(`${url}/who`, as('token-b')), 200);
  });
});

test('maxInflightPerSubject: one subject at its cap gets 429, another subject is served', async () => {
  await withGateway('production', { maxInflightPerSubject: 1 }, async (url) => {
    const first = fetch(`${url}/hold`, as('token-a'));
    await until(() => !!release);
    const refused = await fetch(`${url}/who`, as('token-a'));
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '1');
    await refused.arrayBuffer();
    assert.equal(await status(`${url}/who`, as('token-b')), 200);
    release!();
    await (await first).arrayBuffer();
    await sleep(20);
    assert.equal(await status(`${url}/who`, as('token-a')), 200);
  });
});

test('rateLimitRequests: per subject, per address without a caller; 429 with Retry-After until the window resets', async () => {
  await withGateway('production', { rateLimitRequests: 2, rateLimitWindowMs: 300 }, async (url) => {
    assert.equal(await status(`${url}/who`, as('token-a')), 200);
    assert.equal(await status(`${url}/who`, as('token-a')), 200);
    const limited = await fetch(`${url}/who`, as('token-a'));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '1');
    assert.equal((await limited.json() as { error: { type: string } }).error.type, 'rate_limit_error');
    assert.equal(await status(`${url}/who`, as('token-b')), 200, 'another subject has its own window');
    assert.equal(await status(`${url}/open`), 200);
    assert.equal(await status(`${url}/open`), 200);
    assert.equal(await status(`${url}/open`), 429, 'public routes count by client address');
    await sleep(350);
    assert.equal(await status(`${url}/who`, as('token-a')), 200, 'a new window');
    assert.equal(await status(`${url}/open`), 200);
  });
});

test('rateLimitAuthFailures: an address that keeps failing is refused before verification, valid credentials included, until the window resets', async () => {
  await withGateway('production', { rateLimitAuthFailures: 2, rateLimitWindowMs: 300 }, async (url) => {
    assert.equal(await status(`${url}/who`, as('guess-1')), 401);
    assert.equal(await status(`${url}/who`), 401, 'a request without a credential is not a guess');
    assert.equal(await status(`${url}/who`, as('guess-2')), 401);
    const locked = await fetch(`${url}/who`, as('guess-3'));
    assert.equal(locked.status, 429);
    assert.equal(locked.headers.get('retry-after'), '1');
    await locked.arrayBuffer();
    assert.equal(await status(`${url}/who`, as('token-a')), 429, 'the right credential cannot be told from a wrong one while locked');
    assert.equal(await status(`${url}/open`), 200, 'public routes are not locked');
    await sleep(350);
    assert.equal(await status(`${url}/who`, as('token-a')), 200);
  });
});

test('trustProxy: clients behind a trusted proxy are counted by their forwarded address', async () => {
  await withGateway('production', { rateLimitAuthFailures: 1, trustProxy: 1 }, async (url) => {
    const from = (address: string, token: string) => ({ headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': `9.9.9.9, ${address}` } });
    assert.equal(await status(`${url}/who`, from('203.0.113.1', 'guess')), 401);
    assert.equal(await status(`${url}/who`, from('203.0.113.1', 'token-a')), 429);
    assert.equal(await status(`${url}/who`, from('203.0.113.2', 'token-a')), 200);
  });
  const stack = await stackFor('production');
  await assert.rejects(serveStack(stack, { port: 0, trustProxy: -1 }), /gateway\.trustProxy/);
  await assert.rejects(serveStack(stack, { port: 0, rateLimitRequests: 0 }), /gateway\.rateLimitRequests/);
  await stack.close();
});

test('defaults: the production tier locks an address after 10 failed credentials; the prototype tier stays out of the way', async () => {
  await withGateway('production', {}, async (url) => {
    for (let i = 0; i < 10; i++) assert.equal(await status(`${url}/who`, as(`guess-${i}`)), 401);
    assert.equal(await status(`${url}/who`, as('guess-10')), 429);
  });
  await withGateway('prototype', {}, async (url) => {
    for (let i = 0; i < 40; i++) assert.equal(await status(`${url}/who`, as(`guess-${i}`)), 401);
    for (let batch = 0; batch < 14; batch++) {
      const answers = await Promise.all(Array.from({ length: 50 }, () => status(`${url}/who`, as('token-a'))));
      assert.ok(answers.every((s) => s === 200), 'bursts past the production caps (32 in flight, 600 per minute) pass on the prototype tier');
    }
  });
});
