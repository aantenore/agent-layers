import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeTrace, createTelemetry, recordingTelemetry, type TelemetryPort, type TelemetryRecord, type TraceCodec } from '../src/index.ts';
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
  t.metric('agent.model.tokens', 5, { 'agent.layer': 'llm', 'agent.tokens.kind': 'input', 'agent.tokens.cached_token': 2, 'agent.model.token': 'x' } as never);
  const metric = JSON.stringify(a.records.at(-1));
  assert.match(metric, /"agent\.tokens\.kind":"input","agent\.tokens\.cached_token":2/, 'token counts under agent.tokens. are not masked');
  assert.match(metric, /"agent\.model\.token":"\[redacted\]"/, 'other token-looking keys are');
});

test('span records errors and rethrows', async () => {
  const a = recorder();
  await assert.rejects(createTelemetry([a.telemetry]).span('s', { 'agent.layer': 'llm' }, async () => { throw new Error('bad'); }), /bad/);
  assert.equal(a.records[0]!.type === 'span' && a.records[0]!.status, 'error');
});

// A test format for opaque trace contexts: `<trace>:<span>`.
const codec: TraceCodec = {
  parse: (t) => { const [traceId, spanId] = t.parent.split(':'); return traceId && spanId ? { traceId, spanId, ...(t.state ? { state: t.state } : {}) } : undefined; },
  format: (ids) => ({ parent: `${ids.traceId}:${ids.spanId}`, ...(ids.state ? { state: ids.state } : {}) }),
};

test('trace context is opaque: remote parent and current() fan out unchanged, activeTrace picks the active one', async () => {
  const trace = { parent: 'opaque-parent', state: 'a=1' };
  const parents: unknown[] = [];
  const noIds: TelemetryPort = { span: (_n, _a, fn, o) => { parents.push(o?.parent); return fn({ setAttributes() {}, addEvent() {}, setError() {} }); }, event() {}, metric() {} };
  const withIds: TelemetryPort = { ...noIds, current: () => ({ parent: 'active-span' }) };
  const t = createTelemetry([noIds, withIds]);
  await t.span('s', { 'agent.layer': 'interface' }, async () => {}, { parent: trace });
  await t.span('s', { 'agent.layer': 'interface' }, async () => {}, { parent: { parent: 'garbage' } });
  await t.span('s', { 'agent.layer': 'interface' }, async () => {});
  assert.deepEqual(parents, [trace, trace, { parent: 'garbage' }, { parent: 'garbage' }, undefined, undefined], 'the core does not validate or rewrite the parent');
  assert.deepEqual(t.current?.(), { parent: 'active-span' });
  assert.deepEqual(activeTrace(t), { parent: 'active-span' });
  assert.deepEqual(activeTrace(t, trace), { parent: 'active-span' }, 'the active span wins over the fallback');
  assert.deepEqual(activeTrace(createTelemetry([noIds]), trace), trace);
  assert.equal(activeTrace(createTelemetry([noIds])), undefined);
  assert.equal(activeTrace(undefined), undefined);
  assert.deepEqual(activeTrace(undefined, trace), trace);
});

test('recordingTelemetry with a trace codec nests spans, honours a valid remote parent and starts a new trace otherwise', async () => {
  const records: TelemetryRecord[] = [];
  const t = recordingTelemetry((r) => records.push(r), 'rec', { trace: codec });
  let inner: unknown;
  await t.span('outer', { 'agent.layer': 'harness' }, async () => {
    await t.span('inner', { 'agent.layer': 'llm' }, async () => { inner = t.current?.(); });
  }, { parent: { parent: 'trace1:span1', state: 'k=v' } });
  await t.span('fresh', { 'agent.layer': 'harness' }, async () => {}, { parent: { parent: 'garbage' } });
  const spans = Object.fromEntries(records.flatMap((r) => (r.type === 'span' ? [[r.name, r]] : [])));
  assert.equal(spans.outer!.type === 'span' && spans.outer!.traceId, 'trace1');
  assert.equal(spans.outer!.type === 'span' && spans.outer!.parentSpanId, 'span1');
  assert.equal(spans.inner!.type === 'span' && spans.inner!.parentSpanId, spans.outer!.type === 'span' && spans.outer!.spanId);
  assert.deepEqual(inner, codec.format({ traceId: 'trace1', spanId: (spans.inner as { spanId: string }).spanId, state: 'k=v' }));
  const fresh = spans.fresh as { traceId: string; parentSpanId?: string };
  assert.match(fresh.traceId, /^[0-9a-f]{32}$/);
  assert.equal(fresh.parentSpanId, undefined);

  const plain = recordingTelemetry((r) => records.push(r));
  assert.equal(plain.current, undefined, 'without a codec the recorder keeps no trace ids');
});
