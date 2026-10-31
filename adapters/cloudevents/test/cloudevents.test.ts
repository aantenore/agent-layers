import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compose, defineAdapter, PORT_VERSIONS, resolveProfile,
  type Caller, type RuntimePort, type StackConfig,
} from '@agent-layers/core';
import { adapter as basicRuntime, createBasicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { identityAdapter } from '@agent-layers/adapter-static-identity';
import { serveStack } from '@agent-layers/gateway';
import { adapter as cloudevents } from '../src/index.ts';

interface Seen { runId: string; input: string; caller?: Caller }

/** Delegates to the basic runtime and records what each run received. */
function recordingRuntime(seen: Seen[]) {
  return defineAdapter<'RuntimePort'>({
    layer: 'harness', port: 'RuntimePort', name: 'recording-runtime', direction: 'outbound', maps: { technology: 'test runtime' },
    portVersion: PORT_VERSIONS.RuntimePort, tiers: ['prototype', 'production'], optionsSchema: { type: 'object' },
    create: (): RuntimePort => {
      const inner = createBasicRuntime();
      return {
        name: 'recording-runtime',
        async bind(stack, agent) {
          const bound = await inner.bind(stack, agent);
          return {
            name: bound.name,
            run(input, ctx) {
              seen.push({ runId: ctx?.runId ?? '', input: typeof input === 'string' ? input : JSON.stringify(input), ...(ctx?.caller ? { caller: ctx.caller } : {}) });
              return bound.run(input, ctx);
            },
          };
        },
      };
    },
  });
}

async function setup(options: Record<string, unknown>, tier: 'prototype' | 'production' = 'prototype', gateway: { anonymous?: boolean } = {}) {
  const seen: Seen[] = [];
  const config: StackConfig = {
    agents: { assistant: { instructions: 'Be brief.', model: 'mock' } },
    layers: {
      model: { adapter: 'mock-model', options: { rules: [{ match: '', reply: 'done' }] } },
      runtime: { adapter: 'recording-runtime' },
      identity: {
        adapter: 'static-identity',
        options: { tokens: { 'dev-token': { subject: 'dev-user' }, 'svc-token': { subject: 'events-svc', kind: 'agent' } } },
      },
      triggers: [{ adapter: 'cloudevents', options }],
    },
    profiles: { p: { tier } },
  };
  const stack = await compose(resolveProfile(config, 'p'), { adapters: [mockModel, basicRuntime, identityAdapter, recordingRuntime(seen), cloudevents] });
  const gw = await serveStack(stack, { port: 0, ...gateway });
  const url = `${gw.url}/v1/events`;
  return {
    seen, url,
    async close() {
      await gw.close();
      await stack.close();
    },
  };
}

async function waitFor(seen: Seen[], count = 1): Promise<void> {
  for (let i = 0; i < 100 && seen.length < count; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(seen.length >= count, 'the run did not start');
}

const routes = [{ type: 'com.example.order.*', agent: 'assistant', input: 'Order {{id}} from {{source}}: {{data.customer.name}} ({{data.total}}) {{data}}' }];
const bearer = { authorization: 'Bearer dev-token' };
const structured = { ...bearer, 'content-type': 'application/cloudevents+json; charset=utf-8' };
const event = { specversion: '1.0', id: 'evt-1', source: '/orders', type: 'com.example.order.created', data: { customer: { name: 'Ada' }, total: 12 } };

test('structured mode: 202, rendered template, caller', async () => {
  const t = await setup({ routes });
  try {
    const res = await fetch(t.url, { method: 'POST', headers: structured, body: JSON.stringify(event) });
    assert.equal(res.status, 202);
    const body = await res.json() as { runId: string; agent: string; eventId: string };
    assert.equal(body.agent, 'assistant');
    assert.equal(body.eventId, 'evt-1');
    await waitFor(t.seen);
    assert.equal(t.seen[0]!.runId, body.runId);
    assert.notEqual(body.runId, 'evt-1');
    assert.equal(t.seen[0]!.input, 'Order evt-1 from /orders: Ada (12) {"customer":{"name":"Ada"},"total":12}');
    assert.equal(t.seen[0]!.caller?.id, 'dev-user');
  } finally {
    await t.close();
  }
});

test('binary mode: JSON data, text data, default template', async () => {
  const t = await setup({ routes: [...routes.slice(0, 1), { type: 'com.example.note.*', agent: 'assistant' }] });
  try {
    const ce = { 'ce-specversion': '1.0', 'ce-id': 'b-1', 'ce-source': '/orders', 'ce-type': 'com.example.order.paid', 'ce-time': '2026-01-02T03:04:05Z' };
    const json = await fetch(t.url, { method: 'POST', headers: { ...bearer, ...ce, 'content-type': 'application/json' }, body: JSON.stringify(event.data) });
    assert.equal(json.status, 202);
    const textRes = await fetch(t.url, {
      method: 'POST',
      headers: { ...bearer, ...ce, 'ce-id': 'b-2', 'ce-type': 'com.example.note.added', 'content-type': 'text/plain' },
      body: 'call the customer',
    });
    assert.equal(textRes.status, 202);
    await waitFor(t.seen, 2);
    const inputs = t.seen.map((s) => s.input).sort();
    assert.deepEqual(inputs, ['Order b-1 from /orders: Ada (12) {"customer":{"name":"Ada"},"total":12}', 'call the customer']);
  } finally {
    await t.close();
  }
});

test('a configured credential is the run caller, not the HTTP caller', async () => {
  const t = await setup({ routes, credential: 'svc-token' });
  try {
    const res = await fetch(t.url, { method: 'POST', headers: structured, body: JSON.stringify(event) });
    assert.equal(res.status, 202);
    await waitFor(t.seen);
    assert.equal(t.seen[0]!.caller?.id, 'events-svc');
    assert.equal(t.seen[0]!.caller?.kind, 'agent');
  } finally {
    await t.close();
  }
});

test('a rejected configured credential is a 401 and no run starts', async () => {
  const t = await setup({ routes, credential: 'wrong-token' });
  try {
    const res = await fetch(t.url, { method: 'POST', headers: structured, body: JSON.stringify(event) });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="agent-layers"');
    const text = await res.text();
    assert.ok(!text.includes('wrong-token'));
    assert.equal((JSON.parse(text) as { error: { type: string } }).error.type, 'authentication_error');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.seen.length, 0);
  } finally {
    await t.close();
  }
});

test('invalid events are a 400', async () => {
  const t = await setup({ routes });
  try {
    const noId = await fetch(t.url, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json', 'ce-specversion': '1.0', 'ce-source': '/orders', 'ce-type': 'com.example.order.created' },
      body: '{}',
    });
    assert.equal(noId.status, 400);
    assert.equal(((await noId.json()) as { error: { type: string } }).error.type, 'invalid_request_error');
    const oldSpec = await fetch(t.url, { method: 'POST', headers: structured, body: JSON.stringify({ ...event, specversion: '0.3' }) });
    assert.equal(oldSpec.status, 400);
    const badJson = await fetch(t.url, { method: 'POST', headers: structured, body: '{nope' });
    assert.equal(badJson.status, 400);
    const plain = await fetch(t.url, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(plain.status, 400);
    assert.equal(t.seen.length, 0);
  } finally {
    await t.close();
  }
});

test('no matching route is a 404 and nothing runs', async () => {
  const t = await setup({ routes: [{ ...routes[0]!, source: '/billing' }] });
  try {
    const otherType = await fetch(t.url, { method: 'POST', headers: structured, body: JSON.stringify({ ...event, type: 'com.other.thing' }) });
    assert.equal(otherType.status, 404);
    assert.equal(((await otherType.json()) as { error: { type: string } }).error.type, 'not_found_error');
    const otherSource = await fetch(t.url, { method: 'POST', headers: structured, body: JSON.stringify(event) });
    assert.equal(otherSource.status, 404);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.seen.length, 0);
  } finally {
    await t.close();
  }
});

test('an unknown agent in a route is a 404 from the host', async () => {
  const t = await setup({ routes: [{ type: '*', agent: 'ghost' }] });
  try {
    const res = await fetch(t.url, { method: 'POST', headers: structured, body: JSON.stringify(event) });
    assert.equal(res.status, 404);
  } finally {
    await t.close();
  }
});

test('batch mode is a 415, other methods a 405', async () => {
  const t = await setup({ routes });
  try {
    const batch = await fetch(t.url, { method: 'POST', headers: { ...bearer, 'content-type': 'application/cloudevents-batch+json' }, body: JSON.stringify([event]) });
    assert.equal(batch.status, 415);
    const get = await fetch(t.url, { headers: bearer });
    assert.equal(get.status, 405);
    assert.equal(t.seen.length, 0);
  } finally {
    await t.close();
  }
});

test('production tier: no caller credential and no configured credential is a 401', async () => {
  const t = await setup({ routes }, 'production');
  try {
    const anon = await fetch(t.url, { method: 'POST', headers: { 'content-type': 'application/cloudevents+json' }, body: JSON.stringify(event) });
    assert.equal(anon.status, 401);
    assert.equal(anon.headers.get('www-authenticate'), 'Bearer realm="agent-layers"');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.seen.length, 0);
    const known = await fetch(t.url, { method: 'POST', headers: structured, body: JSON.stringify(event) });
    assert.equal(known.status, 202);
  } finally {
    await t.close();
  }
});

test('a foreign Origin is refused by the gateway before any event is read', async () => {
  const t = await setup({ routes });
  try {
    const res = await fetch(t.url, { method: 'POST', headers: { ...structured, origin: 'http://evil.test' }, body: JSON.stringify(event) });
    assert.equal(res.status, 403);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.seen.length, 0);
  } finally {
    await t.close();
  }
});
