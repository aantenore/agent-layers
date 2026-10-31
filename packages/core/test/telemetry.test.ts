import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTelemetry, traceContext, traceHeaders, type TelemetryPort } from '../src/index.ts';
import { recorder } from './helpers.ts';

test('agent.layer is mandatory', async () => {
  const t = createTelemetry([]);
  await assert.rejects(t.span('x', {} as never, async () => 1), /agent\.layer/);
  assert.throws(() => t.event('x', { 'agent.layer': 'nope' } as never), /agent\.layer/);
});

test('fan-out masks secret-looking attributes and survives a broken event sink', async () => {
  const a = recorder();
  const broken: TelemetryPort = { span: (_n, _a, fn) => fn({ setAttributes() {}, addEvent() {}, setError() {} }), event() { throw new Error('x'); }, metric() {} };
  const t = createTelemetry([a.telemetry, broken]);
  const v = await t.span('s', { 'agent.layer': 'tool', 'auth.token': 'abc', 'http.api_key': 'k', ok: 'y' }, async (s) => { s.setAttributes({ password: 'p' }); return 7; });
  assert.equal(v, 7);
  t.event('e', { 'agent.layer': 'tool', authorization: 'Bearer z' });
  const dump = JSON.stringify(a.records);
  assert.ok(!/abc|"k"|Bearer z|"p"/.test(dump), dump);
  assert.match(dump, /"ok":"y"/);
  t.metric('gen_ai.client.token.usage', 5, { 'agent.layer': 'llm', 'gen_ai.token.type': 'input', 'gen_ai.usage.input_tokens': 5 } as never);
  assert.match(JSON.stringify(a.records.at(-1)), /"gen_ai.token.type":"input","gen_ai.usage.input_tokens":5/, 'semantic-convention keys are not masked');
});

test('span records errors and rethrows', async () => {
  const a = recorder();
  await assert.rejects(createTelemetry([a.telemetry]).span('s', { 'agent.layer': 'llm' }, async () => { throw new Error('bad'); }), /bad/);
  assert.equal(a.records[0]!.type === 'span' && a.records[0]!.status, 'error');
});

test('trace context: parsing, fan-out of the remote parent and of current(), outbound headers', async () => {
  const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  assert.deepEqual(traceContext(` ${tp.toUpperCase()} `, 'a=1'), { traceparent: tp, tracestate: 'a=1' });
  for (const bad of [undefined, '', 'x', 'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', '00-00000000000000000000000000000000-00f067aa0ba902b7-01', '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01']) {
    assert.equal(traceContext(bad), undefined, String(bad));
  }
  assert.deepEqual(traceContext(tp, 'bad\u0001state'), { traceparent: tp }, 'a malformed tracestate is dropped');

  const parents: unknown[] = [];
  const noIds: TelemetryPort = { span: (_n, _a, fn, o) => { parents.push(o?.parent); return fn({ setAttributes() {}, addEvent() {}, setError() {} }); }, event() {}, metric() {} };
  const withIds: TelemetryPort = { ...noIds, current: () => ({ traceparent: tp }) };
  const t = createTelemetry([noIds, withIds]);
  await t.span('s', { 'agent.layer': 'interface' }, async () => {}, { parent: { traceparent: tp } });
  await t.span('s', { 'agent.layer': 'interface' }, async () => {}, { parent: { traceparent: 'garbage' } });
  assert.deepEqual(parents, [{ traceparent: tp }, { traceparent: tp }, undefined, undefined]);
  assert.deepEqual(t.current?.(), { traceparent: tp });
  assert.deepEqual(traceHeaders(t), { traceparent: tp });
  assert.deepEqual(traceHeaders(createTelemetry([noIds]), { traceparent: tp, tracestate: 's=1' }), { traceparent: tp, tracestate: 's=1' });
  assert.deepEqual(traceHeaders(undefined), {});
});
