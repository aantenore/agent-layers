import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import {
  compose, defineAdapter, PORT_VERSIONS, recordingTelemetry, resolveProfile,
  type ChannelPort, type StackConfig, type TelemetryRecord, type TriggerPort, type TriggerSink,
} from '@agent-layers/core';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { identityAdapter } from '@agent-layers/adapter-static-identity';
import { serveStack } from '../src/index.ts';

let sink: TriggerSink | undefined;

const echoChannel = defineAdapter<'ChannelPort'>({
  layer: 'interface', port: 'ChannelPort', name: 'echo-http', direction: 'inbound', maps: { technology: 'test route' },
  portVersion: PORT_VERSIONS.ChannelPort, tiers: ['prototype', 'production'], optionsSchema: { type: 'object' },
  create: (): ChannelPort => ({
    mount: (host) => ({
      routes: [
        { path: '/card', methods: ['GET'], public: true, handle: async (_req, ctx) => Response.json({ url: `${ctx.origin}/echo`, who: ctx.identity?.subject ?? null }) },
        {
          path: '/echo', methods: ['POST'],
          async handle(req, ctx) {
            const { text } = await req.json() as { text: string };
            const r = await host.run('assistant', text, { ...(ctx.identity ? { identity: ctx.identity } : {}) });
            return Response.json({ who: ctx.identity?.subject ?? null, output: r.output, status: r.status });
          },
        },
        { path: '/slow', methods: ['GET'], handle: (_req, ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve(new Response('late')))) },
        { path: '/boom', handle: async () => { throw new Error('upstream said: key sk-live-999'); } },
      ],
    }),
  }),
});

const hookTrigger = defineAdapter<'TriggerPort'>({
  layer: 'interface', port: 'TriggerPort', name: 'hook', direction: 'inbound', maps: { technology: 'test route' },
  portVersion: PORT_VERSIONS.TriggerPort, tiers: ['prototype', 'production'], optionsSchema: { type: 'object' },
  create: (): TriggerPort => ({
    mount: (s) => {
      sink = s;
      return {
        routes: [{
          path: '/hook', methods: ['POST'],
          async handle(_req, ctx) {
            try {
              const { runId } = await s.accept({ id: `t-${Date.now()}`, type: 'test', source: 'test', data: 'hello' }, { ...(ctx.identity ? { identity: ctx.identity } : {}) });
              return Response.json({ runId }, { status: 202 });
            } catch (err) {
              return Response.json({ error: (err as { kind?: string }).kind }, { status: 403 });
            }
          },
        }],
      };
    },
  }),
});

async function stackFor(tier: 'prototype' | 'production', records: TelemetryRecord[] = []) {
  const config: StackConfig = {
    agents: { assistant: { instructions: 'Be brief.', model: 'mock' } },
    layers: {
      model: { adapter: 'mock-model', options: { rules: [{ match: 'ping', reply: 'pong' }] } },
      runtime: { adapter: 'basic-runtime' },
      identity: { adapter: 'static-identity', options: { tokens: { 'dev-token': { subject: 'dev-user' } } } },
      channels: [{ adapter: 'echo-http' }],
      triggers: [{ adapter: 'hook' }],
    },
    profiles: { p: { tier } },
  };
  return compose(resolveProfile(config, 'p'), {
    adapters: [mockModel, basicRuntime, identityAdapter, echoChannel, hookTrigger],
    telemetry: [recordingTelemetry((r) => records.push(r))],
  });
}

const auth = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };

test('health and readiness are public; the request id is echoed; routes are listed', async () => {
  const stack = await stackFor('production');
  const gw = await serveStack(stack, { port: 0 });
  try {
    const health = await fetch(`${gw.url}/healthz`, { headers: { 'x-request-id': 'abc-1' } });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-request-id'), 'abc-1');
    const ready = await fetch(`${gw.url}/readyz`);
    assert.equal(ready.status, 503, 'a production profile without guards, authorization, telemetry and state is not ready');
    assert.deepEqual(gw.routes, ['GET /card (echo-http)', 'POST /echo (echo-http)', 'GET /slow (echo-http)', '* /boom (echo-http)', 'POST /hook (hook)']);
    const card = await (await fetch(`${gw.url}/card`)).json() as { url: string; who: null };
    assert.deepEqual(card, { url: `${gw.url}/echo`, who: null });
  } finally {
    await gw.close();
    await stack.close();
  }
});

test('production tier: no credential or a bad one is a 401 with WWW-Authenticate; a verified caller reaches the run', async () => {
  const stack = await stackFor('production');
  const gw = await serveStack(stack, { port: 0 });
  try {
    const none = await fetch(`${gw.url}/echo`, { method: 'POST', body: '{"text":"ping"}' });
    assert.equal(none.status, 401);
    assert.equal(none.headers.get('www-authenticate'), 'Bearer realm="agent-layers"');
    const bad = await fetch(`${gw.url}/echo`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{"text":"ping"}' });
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get('www-authenticate')!, /error="invalid_token"/);
    assert.ok(!(await bad.text()).includes('nope'));
    const ok = await fetch(`${gw.url}/echo`, { method: 'POST', headers: auth, body: '{"text":"ping"}' });
    assert.deepEqual(await ok.json(), { who: 'dev-user', output: 'pong', status: 'completed' });
  } finally {
    await gw.close();
    await stack.close();
  }
});

test('anonymous callers only with anonymous: true, never on the production tier', async () => {
  const stack = await stackFor('prototype');
  const open = await serveStack(stack, { port: 0, anonymous: true });
  const closed = await serveStack(stack, { port: 0 });
  const prod = await stackFor('production');
  await assert.rejects(serveStack(prod, { port: 0, anonymous: true }), /not allowed on the production tier/);
  await prod.close();
  const noIdentity = await compose(resolveProfile({ layers: { identity: null }, profiles: { p: { tier: 'production' } } }, 'p'));
  await assert.rejects(serveStack(noIdentity, { port: 0 }), /needs an identity adapter/);
  await noIdentity.close();
  try {
    assert.deepEqual(await (await fetch(`${open.url}/echo`, { method: 'POST', body: '{"text":"ping"}' })).json(), { who: null, output: 'pong', status: 'completed' });
    assert.equal((await fetch(`${closed.url}/echo`, { method: 'POST', body: '{"text":"ping"}' })).status, 401);
  } finally {
    await open.close();
    await closed.close();
    await stack.close();
  }
});

test('limits: 404, 405, 413, 504 on timeout, 500 without the error text', async () => {
  const stack = await stackFor('prototype');
  const gw = await serveStack(stack, { port: 0, anonymous: true, maxBodyBytes: 64, requestTimeoutMs: 100 });
  try {
    assert.equal((await fetch(`${gw.url}/nowhere`)).status, 404);
    const wrong = await fetch(`${gw.url}/echo`);
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'POST');
    assert.equal((await fetch(`${gw.url}/echo`, { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(200) }) })).status, 413);
    assert.equal((await fetch(`${gw.url}/slow`)).status, 504);
    const boom = await fetch(`${gw.url}/boom`);
    assert.equal(boom.status, 500);
    assert.ok(!(await boom.text()).includes('sk-live'));
  } finally {
    await gw.close();
    await stack.close();
  }
});

test('access log: one interface span per request, path without the query, status recorded', async () => {
  const records: TelemetryRecord[] = [];
  const stack = await stackFor('prototype', records);
  const gw = await serveStack(stack, { port: 0 });
  try {
    await fetch(`${gw.url}/echo?api_key=secret-in-query`, { method: 'POST', headers: auth, body: '{"text":"ping"}' });
    const span = records.find((r) => r.type === 'span' && r.name === 'gateway.request');
    assert.ok(span && span.type === 'span');
    assert.equal(span.layer, 'interface');
    assert.equal(span.attrs['url.path'], '/echo');
    assert.equal(span.attrs['http.response.status_code'], 200);
    assert.equal(span.attrs['gateway.authenticated'], true);
    assert.ok(records.some((r) => r.type === 'span' && r.name === 'invoke_agent'), 'the run is traced under the request');
    assert.ok(!JSON.stringify(records).includes('secret-in-query'));
    assert.ok(!JSON.stringify(records).includes('dev-token'));
  } finally {
    await gw.close();
    await stack.close();
  }
});

test('CORS is off by default and answers only the configured origins', async () => {
  const stack = await stackFor('prototype');
  const off = await serveStack(stack, { port: 0 });
  const on = await serveStack(stack, { port: 0, cors: { origins: ['http://app.test'] } });
  try {
    assert.equal((await fetch(`${off.url}/healthz`, { headers: { origin: 'http://app.test' } })).headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(`${on.url}/healthz`, { headers: { origin: 'http://app.test' } })).headers.get('access-control-allow-origin'), 'http://app.test');
    assert.equal((await fetch(`${on.url}/healthz`, { headers: { origin: 'http://evil.test' } })).headers.get('access-control-allow-origin'), null);
    const pre = await fetch(`${on.url}/echo`, { method: 'OPTIONS', headers: { origin: 'http://app.test', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
  } finally {
    await off.close();
    await on.close();
    await stack.close();
  }
});

test('triggers: accepted with the caller identity; never anonymous without anonymous: true', async () => {
  const stack = await stackFor('production');
  const gw = await serveStack(stack, { port: 0 });
  try {
    const ok = await fetch(`${gw.url}/hook`, { method: 'POST', headers: auth });
    assert.equal(ok.status, 202);
    assert.match((await ok.json() as { runId: string }).runId, /^t-/);
    await assert.rejects(sink!.accept({ id: 'x', type: 't', source: 's' }), (e: { kind?: string }) => e.kind === 'unauthenticated');
    assert.equal((await fetch(`${gw.url}/hook`, { method: 'POST' })).status, 401);
    await assert.rejects(sink!.accept({ id: 'x', type: 't', source: 's', agent: 'ghost' }, { identity: { subject: 'u', kind: 'user' } }), (e: { kind?: string }) => e.kind === 'not_found');
  } finally {
    await gw.close();
    await stack.close();
  }
});

test('close is graceful: a request in flight completes, new ones are refused', async () => {
  const stack = await stackFor('prototype');
  const gw = await serveStack(stack, { port: 0, anonymous: true });
  const status = new Promise<number>((resolve, reject) => {
    const req = request(`${gw.url}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.write('{"text":');
    setTimeout(() => req.end('"ping"}'), 50);
  });
  await new Promise((r) => setTimeout(r, 20));
  const closed = gw.close();
  assert.equal(await status, 200);
  await closed;
  await assert.rejects(fetch(`${gw.url}/healthz`));
  await stack.close();
});

test('Origin and Host checks: foreign origins and unknown host names get 403', async () => {
  const stack = await stackFor('prototype');
  const gw = await serveStack(stack, { port: 0, anonymous: true, allowedOrigins: ['http://ide.test'] });
  const named = await serveStack(stack, { port: 0, anonymous: true, host: '127.0.0.1', allowedHosts: ['agents.internal'] });
  const send = (url: string, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const req = request(`${url}/echo`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end('{"text":"ping"}');
  });
  try {
    assert.equal(await send(gw.url, { origin: 'http://evil.test' }), 403);
    assert.equal(await send(gw.url, { origin: 'http://ide.test' }), 200);
    assert.equal(await send(gw.url, { origin: gw.url }), 200);
    assert.equal(await send(gw.url, {}), 200, 'no Origin: not a browser, allowed');
    assert.equal(await send(gw.url, { host: 'evil.test' }), 403, 'DNS rebinding: a loopback gateway answers only loopback names');
    assert.equal(await send(gw.url, { host: `localhost:${gw.port}` }), 200);
    assert.equal(await send(named.url, { host: 'agents.internal' }), 200);
    assert.equal(await send(named.url, { host: `127.0.0.1:${named.port}` }), 403);
    assert.equal((await fetch(`${gw.url}/healthz`, { headers: { origin: 'http://evil.test' } })).status, 200, 'health stays reachable');
  } finally {
    await gw.close();
    await named.close();
    await stack.close();
  }
});
