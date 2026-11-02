import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, ConfigError, defineAdapter, PORT_VERSIONS, recordingTelemetry, resolveProfile, type ChannelPort, type TriggerPort } from '@agent-layers/core';
import { identityAdapter } from '@agent-layers/adapter-static-identity';
import { serveStack } from '../src/index.ts';

const whoChannel = defineAdapter<'ChannelPort'>({
  layer: 'interface', port: 'ChannelPort', name: 'who', direction: 'inbound', maps: { technology: 'test route' },
  portVersion: PORT_VERSIONS.ChannelPort, tiers: ['prototype'], optionsSchema: { type: 'object' },
  create: (): ChannelPort => ({ mount: () => ({ routes: [{ path: '/who', methods: ['GET'], handle: async (_req, ctx) => Response.json({ who: ctx.caller?.id ?? null }) }] }) }),
});

const runs: { sessionId?: string; caller?: string }[] = [];
const sessionTrigger = defineAdapter<'TriggerPort'>({
  layer: 'interface', port: 'TriggerPort', name: 'session-hook', direction: 'inbound', maps: { technology: 'test route' },
  portVersion: PORT_VERSIONS.TriggerPort, tiers: ['prototype'], optionsSchema: { type: 'object' },
  create: (): TriggerPort => ({
    mount: (sink) => ({
      routes: [{
        path: '/hook', methods: ['POST'],
        handle: async (_req, ctx) => Response.json(await sink.accept({ id: `t-${runs.length}`, kind: 'test', source: 'test', agent: 'a', data: 'hi' }, { ...(ctx.caller ? { caller: ctx.caller } : {}), sessionId: 'sess-1' }), { status: 202 }),
      }],
    }),
  }),
});

const stackOf = () => compose(resolveProfile({
  agents: { a: { model: 'm' } },
  layers: {
    identity: { adapter: 'static-identity', options: { tokens: { 'key-123': { subject: 'svc' } } } },
    runtime: { adapter: 'record' }, channels: [{ adapter: 'who' }], triggers: [{ adapter: 'session-hook' }],
  },
}), {
  adapters: [identityAdapter, whoChannel, sessionTrigger, defineAdapter<'RuntimePort'>({
    layer: 'harness', port: 'RuntimePort', name: 'record', direction: 'outbound', maps: { technology: 'test double' },
    portVersion: PORT_VERSIONS.RuntimePort, tiers: ['prototype'], optionsSchema: { type: 'object' },
    create: () => ({
      bind: (_s, agent) => ({
        name: agent.name,
        run: async (_i, c) => {
          runs.push({ ...(c?.sessionId ? { sessionId: c.sessionId } : {}), ...(c?.caller ? { caller: c.caller.id } : {}) });
          return { runId: c?.runId ?? 'r', status: 'completed', output: 'ok' };
        },
      }),
    }),
  })],
});

test('gateway.auth scheme header: the raw value of the named header is the credential; Bearer is not read', async () => {
  const stack = await stackOf();
  const gw = await serveStack(stack, { port: 0, auth: { scheme: 'header', header: 'X-Api-Key' } });
  try {
    const who = (h: Record<string, string>) => fetch(`${gw.url}/who`, { headers: h });
    assert.deepEqual(await (await who({ 'x-api-key': 'key-123' })).json(), { who: 'svc' });
    const bearer = await who({ authorization: 'Bearer key-123' });
    assert.equal(bearer.status, 401);
    assert.equal(bearer.headers.get('www-authenticate'), 'ApiKey realm="agent-layers"');
    assert.equal((await who({ 'x-api-key': 'wrong' })).status, 401);
  } finally {
    await gw.close();
  }
  const bearer = await serveStack(stack, { port: 0 });
  try {
    assert.deepEqual(await (await fetch(`${bearer.url}/who`, { headers: { authorization: 'Bearer key-123' } })).json(), { who: 'svc' }, 'default: bearer');
    assert.equal((await fetch(`${bearer.url}/who`, { headers: { 'x-api-key': 'key-123' } })).status, 401);
  } finally {
    await bearer.close();
  }
  await assert.rejects(serveStack(stack, { port: 0, auth: { scheme: 'header' } }), (e: unknown) => e instanceof ConfigError && /gateway\.auth\.header/.test(e.message));
  await stack.close();
});

test('a trigger accepted with a session runs in that session', async () => {
  const stack = await stackOf();
  const gw = await serveStack(stack, { port: 0 });
  try {
    runs.length = 0;
    assert.equal((await fetch(`${gw.url}/hook`, { method: 'POST', headers: { authorization: 'Bearer key-123' } })).status, 202);
  } finally {
    await gw.close();
  }
  assert.deepEqual(runs, [{ sessionId: 'sess-1', caller: 'svc' }]);
  await stack.close();
});

test('a trigger that only starts is reported: the gateway never runs it', async () => {
  const timer = defineAdapter<'TriggerPort'>({
    layer: 'interface', port: 'TriggerPort', name: 'timer', direction: 'inbound', maps: { technology: 'test timer' },
    portVersion: PORT_VERSIONS.TriggerPort, tiers: ['prototype'], optionsSchema: { type: 'object' },
    create: (): TriggerPort => ({ start: async () => ({ close: async () => {} }) }),
  });
  const events: string[] = [];
  const stack = await compose(resolveProfile({
    agents: { a: { model: 'm' } },
    layers: { channels: [{ adapter: 'who' }], triggers: [{ adapter: 'timer', name: 'nightly' }] },
  }), { adapters: [whoChannel, timer], telemetry: [recordingTelemetry((r) => { if (r.type === 'event') events.push(`${r.name} ${String(r.attrs['agent.error'])}`); })] });
  const gw = await serveStack(stack, { port: 0, anonymous: true });
  try {
    assert.deepEqual(gw.warnings, ['trigger "nightly" only starts in its own process (agent-layers dev, stack.start()): the gateway does not run it']);
    assert.ok(events.some((e) => e.startsWith('agent.config.warning trigger "nightly"')));
    assert.deepEqual(gw.routes, ['GET /who (who)']);
  } finally {
    await gw.close();
    await stack.close();
  }
});
