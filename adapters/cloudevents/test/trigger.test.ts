// The Trigger an event becomes, checked against a fake sink: no gateway, no runtime.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter, inboundFetch } from '@agent-layers/conformance';
import { createMappings, type Caller, type InboundMount, type Trigger, type TriggerSink } from '@agent-layers/core';
import { adapter, createCloudEventsTrigger } from '../src/index.ts';

const routes = [{ type: 'com.example.*', agent: 'assistant' }];
const caller: Caller = { id: 'gw-user', kind: 'user', roles: [], scopes: [] };
const service: Caller = { id: 'events-svc', kind: 'agent', roles: [], scopes: [] };
const base = { specversion: '1.0', id: 'evt-77', source: '/shop', type: 'com.example.order.created', time: '2026-10-31T09:30:00Z' };

function sink() {
  const accepted: { trigger: Trigger; caller?: Caller }[] = [];
  const s: TriggerSink = {
    agents: () => ['assistant'],
    async accept(trigger, ctx) { accepted.push({ trigger, ...(ctx?.caller ? { caller: ctx.caller } : {}) }); return { runId: trigger.id }; },
    async verify(credential) { if (credential !== 'svc') throw new Error('no'); return service; },
  };
  return { s, accepted };
}

async function post(mount: InboundMount, body: unknown, headers: Record<string, string> = { 'content-type': 'application/cloudevents+json' }) {
  return inboundFetch(mount, new Request('http://host/v1/events', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }), { caller });
}

test('the trigger carries the upstream id, subject, content type, schema and extensions in ext', async () => {
  const { s, accepted } = sink();
  const mount = await createCloudEventsTrigger({ routes }).mount!(s);
  const res = await post(mount, {
    ...base, subject: 'order/77', datacontenttype: 'application/json', dataschema: 'https://example.com/order.json',
    traceid: 'abc123', priority: 3, urgent: true, 'Bad-Name': 'x', nested: { no: 1 }, data: { total: 12 },
  });
  assert.equal(res.status, 202);
  const { trigger } = accepted[0]!;
  assert.equal(trigger.kind, base.type);
  assert.equal(trigger.source, '/shop');
  assert.equal(trigger.at, base.time);
  assert.equal(trigger.agent, 'assistant');
  assert.equal(trigger.data, '{"total":12}');
  assert.notEqual(trigger.id, 'evt-77', 'the SDK id is its own');
  assert.deepEqual(trigger.ext, {
    'cloudevents.id': 'evt-77',
    'cloudevents.subject': 'order/77',
    'cloudevents.datacontenttype': 'application/json',
    'cloudevents.dataschema': 'https://example.com/order.json',
    'cloudevents.extensions': { traceid: 'abc123', priority: 3, urgent: true },
  });
  assert.equal(((await res.json()) as { eventId: string }).eventId, 'evt-77');
});

test('binary mode: Content-Type is the data content type, ce- headers beyond the context are extensions', async () => {
  const { s, accepted } = sink();
  const mount = await createCloudEventsTrigger({ routes }).mount!(s);
  const res = await post(mount, 'hello', {
    'content-type': 'text/plain; charset=utf-8', 'ce-specversion': '1.0', 'ce-id': 'evt-9', 'ce-source': '/n', 'ce-type': 'com.example.note',
    'ce-subject': 'n/1', 'ce-dataschema': 'https://example.com/n', 'ce-region': 'eu',
  });
  assert.equal(res.status, 202);
  assert.deepEqual(accepted[0]!.trigger.ext, {
    'cloudevents.id': 'evt-9', 'cloudevents.subject': 'n/1', 'cloudevents.datacontenttype': 'text/plain; charset=utf-8',
    'cloudevents.dataschema': 'https://example.com/n', 'cloudevents.extensions': { region: 'eu' },
  });
});

test('a redelivery keeps the upstream id and gets its own SDK id', async () => {
  const { s, accepted } = sink();
  const mount = await createCloudEventsTrigger({ routes }).mount!(s);
  await post(mount, base);
  await post(mount, base);
  const [a, b] = accepted.map((x) => x.trigger);
  assert.equal(a!.ext?.['cloudevents.id'], 'evt-77');
  assert.equal(b!.ext?.['cloudevents.id'], 'evt-77');
  assert.equal(a!.source, b!.source);
  assert.notEqual(a!.id, b!.id);
  assert.deepEqual(Object.keys(a!.ext!), ['cloudevents.id'], 'absent attributes are omitted');
});

test('accept gets the HTTP caller, or the verified service credential', async () => {
  const one = sink();
  await post(await createCloudEventsTrigger({ routes }).mount!(one.s), base);
  assert.deepEqual(one.accepted[0]!.caller, caller);
  const two = sink();
  await post(await createCloudEventsTrigger({ routes, credential: 'svc' }).mount!(two.s), base);
  assert.deepEqual(two.accepted[0]!.caller, service);
  const three = sink();
  const refused = await post(await createCloudEventsTrigger({ routes, credential: 'nope' }).mount!(three.s), base);
  assert.equal(refused.status, 401);
  assert.equal(three.accepted.length, 0);
});

test('mappings.in runs over the event document and may add ext keys of the adapter', async () => {
  const { s, accepted } = sink();
  const mappings = createMappings('triggers.cloudevents', { in: [
    { from: '/region', to: '/ext/cloudevents.region' },
    { from: '/data/priority', to: '/ext/cloudevents.priority' },
    { from: '/subject', to: '/agent', map: { 'order/77': 'assistant' } },
  ] });
  const mount = await createCloudEventsTrigger({ routes }, 'cloudevents', { mappings }).mount!(s);
  await post(mount, { ...base, subject: 'order/77', region: 'eu', data: { priority: 'high' } });
  const { trigger } = accepted[0]!;
  assert.equal(trigger.ext?.['cloudevents.region'], 'eu');
  assert.equal(trigger.ext?.['cloudevents.priority'], 'high');
  assert.equal(trigger.ext?.['cloudevents.id'], 'evt-77', 'rules do not remove what the adapter wrote');
});

test('the receive span carries agent.trigger.kind', async () => {
  const { s } = sink();
  const spans: { name: string; attrs: Record<string, unknown> }[] = [];
  const telemetry = {
    name: 'rec', async span(name: string, attrs: Record<string, unknown>, fn: (sp: { setAttributes(): void }) => Promise<unknown>) { spans.push({ name, attrs }); return fn({ setAttributes() {} }); },
    event() {}, metric() {},
  };
  const mount = await createCloudEventsTrigger({ routes }, 'cloudevents', { telemetry: telemetry as never }).mount!(s);
  await post(mount, base);
  assert.equal(spans[0]!.name, 'cloudevents.receive');
  assert.equal(spans[0]!.attrs['agent.trigger.kind'], base.type);
  assert.equal(spans[0]!.attrs['agent.layer'], 'interface');
  assert.equal(spans[0]!.attrs['agent.name'], 'assistant');
});

test('conformance with the declared ext keys', async () => {
  const report = await checkAdapter(adapter, {
    options: { routes },
    fixtures: { fireMount: async (mount: InboundMount) => { assert.equal((await post(mount, { ...base, subject: 's', datacontenttype: 'application/json', dataschema: 'https://e.test/s', extra: 'x' })).status, 202); } },
  });
  assert.deepEqual(report.failures, []);
});
