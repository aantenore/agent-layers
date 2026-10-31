import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, defineAdapter, PORT_VERSIONS, resolveProfile, type ChannelPort, type SpanOptions, type TelemetryPort } from '@agent-layers/core';
import { identityAdapter } from '@agent-layers/adapter-static-identity';
import { serveStack } from '../src/index.ts';

const traceChannel = defineAdapter<'ChannelPort'>({
  layer: 'interface', port: 'ChannelPort', name: 'trace-echo', direction: 'inbound', maps: { technology: 'test route' },
  portVersion: PORT_VERSIONS.ChannelPort, tiers: ['prototype'], optionsSchema: { type: 'object' },
  create: (): ChannelPort => ({ mount: () => ({ routes: [{ path: '/trace', methods: ['GET'], handle: async (_req, ctx) => Response.json(ctx.trace ?? null) }] }) }),
});

test('the gateway joins the caller trace: request span parented on traceparent, context passed to the route', async () => {
  const spans: { name: string; opts?: SpanOptions }[] = [];
  const capture: TelemetryPort = { span: (name, _a, fn, opts) => { spans.push({ name, ...(opts ? { opts } : {}) }); return fn({ setAttributes() {}, addEvent() {}, setError() {} }); }, event() {}, metric() {} };
  const stack = await compose(resolveProfile({
    layers: { identity: { adapter: 'static-identity', options: { tokens: { t: { subject: 'u' } } } }, channels: [{ adapter: 'trace-echo' }] },
  }), { adapters: [identityAdapter, traceChannel], telemetry: [capture] });
  const gw = await serveStack(stack, { port: 0 });
  try {
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const get = (h: Record<string, string>) => fetch(`${gw.url}/trace`, { headers: { authorization: 'Bearer t', ...h } }).then((r) => r.json());
    assert.deepEqual(await get({ traceparent, tracestate: 'v=1' }), { traceparent, tracestate: 'v=1' });
    assert.deepEqual(spans.at(-1), { name: 'gateway.request', opts: { parent: { traceparent, tracestate: 'v=1' } } });
    assert.equal(await get({ traceparent: 'not-a-trace' }), null);
    assert.deepEqual(spans.at(-1), { name: 'gateway.request' });
  } finally {
    await gw.close();
    await stack.close();
  }
});
