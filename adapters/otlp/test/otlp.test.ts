import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createOtlpTelemetry, type OtlpOptions } from '../src/index.ts';
import { attr, collector, redirecting, type Collector, type OtlpSpan } from './collector.ts';

let sink: Collector;
before(async () => { sink = await collector(); });
beforeEach(() => { sink.requests.length = 0; sink.failWith(undefined); });
after(() => sink.close());

const make = (o: OtlpOptions = {}) => createOtlpTelemetry({ endpoint: sink.url, intervalMs: 60_000, ...o });
const L = (layer: 'harness' | 'llm' | 'guardrail' | 'tool' | 'knowledge' | 'telemetry', extra: Record<string, string | number | boolean> = {}) => ({ 'agent.layer': layer, ...extra }) as { 'agent.layer': typeof layer };
const byName = (spans: OtlpSpan[], name: string) => spans.find((s) => s.name === name)!;

test('spans started inside a span are its children; one trace per run', async () => {
  const t = make();
  await t.span('agent.run', L('harness', { 'agent.name': 'support' }), async () => {
    await t.span('agent.guard.check', L('guardrail'), async () => {});
    await t.span('agent.model.call', L('llm', { 'agent.model.requested': 'm1' }), async () => {
      await t.span('inner', L('telemetry'), async () => {});
    });
  });
  await t.flush!();
  const spans = sink.spans();
  const run = byName(spans, 'invoke_agent support');
  const guard = byName(spans, 'agent.guard.check');
  const chat = byName(spans, 'chat m1');
  const inner = byName(spans, 'inner');
  assert.equal(run.parentSpanId, undefined);
  assert.equal(guard.parentSpanId, run.spanId);
  assert.equal(chat.parentSpanId, run.spanId);
  assert.equal(inner.parentSpanId, chat.spanId);
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 1);
  assert.match(run.traceId, /^[0-9a-f]{32}$/);
  assert.match(run.spanId, /^[0-9a-f]{16}$/);
});

test('concurrent runs keep their own parents and traces', async () => {
  const t = make();
  const run = (id: string, delay: number) => t.span('agent.run', L('harness', { 'agent.run.id': id }), async () => {
    await new Promise((r) => setTimeout(r, delay));
    await t.span('agent.model.call', L('llm', { 'agent.run.id': id }), async () => { await new Promise((r) => setTimeout(r, delay)); });
  });
  await Promise.all([run('a', 20), run('b', 5), run('c', 12)]);
  await t.flush!();
  const spans = sink.spans();
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 3);
  for (const chat of spans.filter((s) => s.name === 'chat')) {
    const parent = spans.find((s) => s.spanId === chat.parentSpanId)!;
    assert.equal(attr(parent, 'agent.run.id'), attr(chat, 'agent.run.id'));
    assert.equal(parent.traceId, chat.traceId);
  }
});

test('siblings that run in parallel share the parent', async () => {
  const t = make();
  await t.span('agent.run', L('harness'), () => Promise.all([
    t.span('agent.knowledge.search', L('knowledge', { 'agent.knowledge.source': 'a' }), async () => {}),
    t.span('agent.knowledge.search', L('knowledge', { 'agent.knowledge.source': 'b' }), async () => {}),
  ]));
  await t.flush!();
  const spans = sink.spans();
  const run = byName(spans, 'invoke_agent');
  assert.deepEqual(spans.filter((s) => s.name === 'agent.knowledge.search').map((s) => s.parentSpanId), [run.spanId, run.spanId]);
});

test('every span carries agent.layer, timing is ordered, kinds follow the operation', async () => {
  const t = make();
  await t.span('agent.run', L('harness'), async () => {
    await t.span('agent.model.call', L('llm'), async () => { await new Promise((r) => setTimeout(r, 5)); });
    await t.span('agent.tool.call', L('tool'), async () => {});
    await t.span('agent.guard.check', L('guardrail'), async () => {});
  });
  await t.flush!();
  for (const s of sink.spans()) {
    assert.ok(attr(s, 'agent.layer'), `${s.name} has agent.layer`);
    assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano));
  }
  assert.equal(byName(sink.spans(), 'chat').kind, 3);
  assert.equal(byName(sink.spans(), 'execute_tool').kind, 1);
  assert.equal(byName(sink.spans(), 'invoke_agent').kind, 1);
  assert.equal(byName(sink.spans(), 'agent.guard.check').kind, 1);
});

test('names follow the GenAI conventions, and can be left plain', async () => {
  const run = async (o: OtlpOptions) => {
    sink.requests.length = 0;
    const t = make(o);
    await t.span('agent.tool.call', L('tool', { 'agent.tool.name': 'crm__get' }), async () => {});
    await t.flush!();
    return sink.spans()[0]!;
  };
  assert.equal((await run({})).name, 'execute_tool crm__get');
  const plain = await run({ semconvNames: false });
  assert.equal(plain.name, 'agent.tool.call');
  assert.equal(attr(plain, 'gen_ai.operation.name'), 'execute_tool', 'attributes are mapped either way');
});

test('span values, errors and status: the value passes through, the same error is rethrown', async () => {
  const t = make();
  assert.equal(await t.span('ok', L('tool'), async () => 7), 7);
  const boom = new TypeError('database password=hunter2 refused');
  await assert.rejects(t.span('bad', L('tool'), async () => { throw boom; }), (e) => e === boom);
  await t.span('soft', L('tool'), async (s) => { s.setError(new Error('soft failure')); });
  await t.flush!();
  const spans = sink.spans();
  assert.equal(byName(spans, 'ok').status, undefined);
  assert.equal(byName(spans, 'bad').status?.code, 2);
  assert.equal(attr(byName(spans, 'bad'), 'error.type'), 'TypeError');
  assert.equal(byName(spans, 'soft').status?.code, 2);
  // Error text can hold content: it is exported only with captureContent.
  assert.equal(byName(spans, 'bad').status?.message, undefined);
  assert.ok(!JSON.stringify(sink.requests).includes('hunter2'));
});

test('captureContent exports error text and content attributes; off by default', async () => {
  const content = { 'gen_ai.input.messages': '[{"role":"user"}]', 'gen_ai.tool.call.arguments': '{"id":1}', 'agent.access.reason': 'denied by policy', 'agent.error': 'refused by crm', 'knowledge.query': 'salary of bob' };
  const run = async (o: OtlpOptions) => {
    sink.requests.length = 0;
    const t = make(o);
    await t.span('x', L('tool', { ...content, 'agent.tool.source': 'crm', 'agent.run.reason': 'guard_block' }), async (s) => { s.setAttributes({ 'gen_ai.tool.call.result': 'rows' }); throw new Error('timeout talking to crm'); }).catch(() => {});
    await t.flush!();
    return sink.spans()[0]!;
  };
  const off = await run({});
  for (const k of [...Object.keys(content), 'gen_ai.tool.call.result']) assert.equal(attr(off, k), undefined, k);
  assert.equal(attr(off, 'agent.tool.source'), 'crm');
  assert.equal(attr(off, 'agent.run.reason'), 'guard_block', 'the stop code is not free text');
  const on = await run({ captureContent: true });
  for (const k of [...Object.keys(content), 'gen_ai.tool.call.result']) assert.ok(attr(on, k) !== undefined, k);
  assert.equal(on.status?.message, 'timeout talking to crm');
});

test('secret-looking attributes are masked even when the stack did not do it', async () => {
  const t = make();
  await t.span('x', L('tool', { 'http.request.header.authorization': 'Bearer abc', api_key: 'k-123' } as never), async (s) => { s.setAttributes({ 'db.password': 'p' }); });
  await t.flush!();
  const body = JSON.stringify(sink.requests);
  for (const secret of ['Bearer abc', 'k-123', '"p"']) assert.ok(!body.includes(secret), secret);
  assert.equal(attr(sink.spans()[0]!, 'db.password'), '[redacted]');
});

test('events attach to the active span; span.addEvent works; orphans become spans or are dropped', async () => {
  const t = make();
  await t.span('run', L('harness'), async (s) => {
    t.event('agent.knowledge.error', L('knowledge', { 'agent.knowledge.source': 'docs' }));
    s.addEvent('step', { n: 2 });
  });
  t.event('lonely', L('telemetry'));
  await t.flush!();
  const run = byName(sink.spans(), 'run');
  assert.deepEqual(run.events!.map((e) => e.name), ['agent.knowledge.error', 'step']);
  const lonely = byName(sink.spans(), 'lonely');
  assert.equal(attr(lonely, 'agent.layer'), 'telemetry');
  assert.equal(lonely.parentSpanId, undefined);

  sink.requests.length = 0;
  const quiet = make({ orphanEvents: 'drop' });
  quiet.event('lonely', L('telemetry'));
  await quiet.flush!();
  assert.equal(sink.spans().length, 0);
});

test('metrics: token histogram, counters, derived model duration and run counter, cumulative', async () => {
  const t = make();
  await t.span('agent.run', L('harness', { 'agent.name': 'support' }), async (run) => {
    await t.span('agent.model.call', L('llm', { 'agent.model.requested': 'm1' }), async () => {
      t.metric('agent.model.tokens', 100, L('llm', { 'agent.tokens.kind': 'input', 'agent.model.used': 'm1-2025' }));
      t.metric('agent.model.tokens', 20, L('llm', { 'agent.tokens.kind': 'output', 'agent.model.used': 'm1-2025' }));
    });
    t.metric('agent.guard.actions', 1, L('guardrail', { 'agent.guard.action': 'redact' }));
    t.metric('agent.guard.actions', 1, L('guardrail', { 'agent.guard.action': 'redact' }));
    run.setAttributes({ 'agent.run.status': 'completed' });
  });
  await t.flush!();
  const metrics = sink.metrics();
  const named = (n: string) => metrics.find((m) => m.name === n)!;
  assert.equal(named('agent.model.tokens'), undefined, 'the language name is not exported');
  const tokens = named('gen_ai.client.token.usage');
  assert.equal(tokens.unit, '{token}');
  assert.equal(tokens.histogram.aggregationTemporality, 2);
  const key = (p: any, k: string) => p.attributes.find((a: any) => a.key === k)?.value.stringValue;
  const input = tokens.histogram.dataPoints.find((p: any) => key(p, 'gen_ai.token.type') === 'input');
  assert.equal(input.count, '1');
  assert.equal(input.sum, 100);
  assert.equal(input.bucketCounts.length, input.explicitBounds.length + 1);
  assert.equal(input.bucketCounts.map(Number).reduce((a: number, b: number) => a + b), 1);
  assert.ok(input.attributes.some((a: any) => a.key === 'agent.layer'));
  assert.equal(key(input, 'gen_ai.operation.name'), 'chat');
  assert.equal(key(input, 'gen_ai.response.model'), 'm1-2025');
  assert.equal(key(input, 'agent.tokens.kind'), 'input', 'the language attribute is kept');
  const guard = named('agent.guard.actions').sum;
  assert.equal(guard.isMonotonic, true);
  assert.equal(guard.dataPoints[0].asDouble, 2);
  const duration = named('gen_ai.client.operation.duration').histogram.dataPoints[0];
  assert.equal(duration.count, '1');
  assert.equal(key(duration, 'gen_ai.request.model'), 'm1');
  const runs = named('agent.runs').sum.dataPoints[0];
  assert.equal(key(runs, 'agent.run.status'), 'completed');
  assert.equal(key(runs, 'gen_ai.agent.name'), 'support');

  t.metric('agent.guard.actions', 1, L('guardrail', { 'agent.guard.action': 'redact' }));
  await t.flush!();
  const again = sink.metrics().filter((m) => m.name === 'agent.guard.actions').at(-1);
  assert.equal(again.sum.dataPoints[0].asDouble, 3, 'cumulative totals');
});

test('GenAI mapping: names, kinds, attributes and finish reasons; agent.* attributes stay', async () => {
  const t = make();
  await t.span('agent.run', L('harness', { 'agent.name': 'support', 'agent.run.id': 'r1' }), async () => {
    await t.span('agent.model.call', L('llm', { 'agent.model.requested': 'm1' }), async (s) => {
      s.setAttributes({ 'agent.model.used': 'm1-2025', 'agent.tokens.input': 12, 'agent.tokens.output': 5, 'agent.model.finish': 'tools' });
    });
    await t.span('agent.tool.call', L('tool', { 'agent.tool.name': 'crm__get', 'agent.tool.source': 'crm' }), async () => {});
    await t.span('agent.guard.check', L('guardrail', { 'agent.guard.name': 'pii' }), async () => {});
  });
  await t.flush!();
  const spans = sink.spans();
  const run = byName(spans, 'invoke_agent support');
  assert.equal(attr(run, 'gen_ai.operation.name'), 'invoke_agent');
  assert.equal(attr(run, 'gen_ai.agent.name'), 'support');
  assert.equal(attr(run, 'agent.name'), 'support');
  assert.equal(attr(run, 'agent.run.id'), 'r1', 'unmapped agent.* pass unchanged');
  const chat = byName(spans, 'chat m1');
  assert.equal(chat.kind, 3);
  assert.equal(attr(chat, 'gen_ai.operation.name'), 'chat');
  assert.equal(attr(chat, 'gen_ai.request.model'), 'm1');
  assert.equal(attr(chat, 'gen_ai.response.model'), 'm1-2025');
  assert.equal(attr(chat, 'gen_ai.usage.input_tokens'), 12);
  assert.equal(attr(chat, 'gen_ai.usage.output_tokens'), 5);
  assert.deepEqual((chat.attributes.find((a) => a.key === 'gen_ai.response.finish_reasons')!.value as any).arrayValue.values, [{ stringValue: 'tool_calls' }]);
  assert.equal(attr(chat, 'agent.model.finish'), 'tools');
  assert.equal(attr(chat, 'agent.tokens.input'), 12);
  const tool = byName(spans, 'execute_tool crm__get');
  assert.equal(attr(tool, 'gen_ai.operation.name'), 'execute_tool');
  assert.equal(attr(tool, 'gen_ai.tool.name'), 'crm__get');
  assert.equal(attr(tool, 'agent.tool.source'), 'crm');
  const guard = byName(spans, 'agent.guard.check');
  assert.equal(attr(guard, 'agent.guard.name'), 'pii');
  assert.ok(!guard.attributes.some((a) => a.key.startsWith('gen_ai.')), 'spans without a GenAI equivalent get no gen_ai attributes');
});

test('finish reasons: end, limit, tools, refused map; other and unknown values pass through', async () => {
  const t = make();
  const finishes = ['end', 'limit', 'tools', 'refused', 'other', 'weird'];
  for (const finish of finishes) await t.span('agent.model.call', L('llm', { 'agent.model.finish': finish }), async () => {});
  await t.flush!();
  const out = sink.spans().map((s) => ((s.attributes.find((a) => a.key === 'gen_ai.response.finish_reasons')!.value as any).arrayValue.values[0].stringValue));
  assert.deepEqual(out, ['stop', 'length', 'tool_calls', 'content_filter', 'other', 'weird']);
});

test('a failed run counts as failed; a failed model call keeps error.type on the duration metric', async () => {
  const t = make();
  await assert.rejects(t.span('agent.run', L('harness', { 'agent.name': 'a' }), async () => {
    await t.span('agent.model.call', L('llm', { 'agent.model.requested': 'm1' }), async () => { throw new RangeError('x'); });
  }));
  await t.flush!();
  const point = (n: string) => sink.metrics().find((m) => m.name === n)!;
  const status = (p: any, k: string) => p.attributes.find((a: any) => a.key === k)?.value.stringValue;
  assert.equal(status(point('agent.runs').sum.dataPoints[0], 'agent.run.status'), 'failed');
  assert.equal(status(point('gen_ai.client.operation.duration').histogram.dataPoints[0], 'error.type'), 'RangeError');
});

test('metrics can be switched off; nothing is sent when nothing changed', async () => {
  const off = make({ metrics: false });
  off.metric('x', 1, L('telemetry'));
  await off.flush!();
  assert.equal(sink.requests.length, 0);
  const t = make();
  t.metric('x', 1, L('telemetry'));
  await t.flush!();
  await t.flush!();
  assert.equal(sink.requests.filter((r) => r.path === '/v1/metrics').length, 1);
});

test('endpoint: base URL, full traces URL, OTEL_EXPORTER_OTLP_ENDPOINT; headers and resource', async () => {
  for (const endpoint of [sink.url, `${sink.url}/`, `${sink.url}/v1/traces`]) {
    sink.requests.length = 0;
    const t = createOtlpTelemetry({ endpoint, headers: { authorization: 'Basic abc' }, serviceName: 'svc', resourceAttributes: { 'deployment.environment': 'test' } });
    await t.span('x', L('telemetry'), async () => {});
    await t.close!();
    assert.deepEqual(sink.requests.map((r) => r.path), ['/v1/traces']);
    assert.equal(sink.requests[0]!.headers.authorization, 'Basic abc');
    const res = sink.resources()[0].attributes;
    assert.deepEqual(res.map((a: any) => [a.key, Object.values(a.value)[0]]), [['service.name', 'svc'], ['deployment.environment', 'test']]);
  }
  sink.requests.length = 0;
  const viaEnv = createOtlpTelemetry({}, { env: { OTEL_EXPORTER_OTLP_ENDPOINT: sink.url, OTEL_SERVICE_NAME: 'from-env' } });
  await viaEnv.span('x', L('telemetry'), async () => {});
  await viaEnv.close!();
  assert.equal(sink.requests.length, 1);
  assert.equal(sink.resources()[0].attributes[0].value.stringValue, 'from-env');
});

test('an unreachable or failing collector never breaks the run; one warning per signal', async () => {
  const warnings: string[] = [];
  const onWarning = (w: Error) => { warnings.push(w.message); };
  process.on('warning', onWarning);
  try {
    sink.failWith(503);
    const t = make();
    for (let i = 0; i < 3; i++) {
      assert.equal(await t.span('x', L('telemetry'), async () => i), i);
      t.metric('m', 1, L('telemetry'));
      await t.flush!();
    }
    const down = createOtlpTelemetry({ endpoint: 'http://127.0.0.1:1', timeoutMs: 300 });
    await down.span('x', L('telemetry'), async () => {});
    await down.flush!();
    await new Promise((r) => setImmediate(r));
  } finally { process.off('warning', onWarning); }
  assert.equal(warnings.filter((w) => w.includes('trace export')).length, 2, 'one per endpoint');
  assert.equal(warnings.filter((w) => w.includes('metric export')).length, 1);
  assert.ok(warnings.every((w) => !w.includes('/v1/')), 'only the origin is named');
});

test('metrics survive a failed export and are sent by the next one', async () => {
  const t = make();
  sink.failWith(500);
  t.metric('agent.runs', 1, L('harness'));
  await t.flush!();
  sink.failWith(undefined);
  await t.flush!();
  assert.equal(sink.metrics().filter((m) => m.name === 'agent.runs').length, 2);
});

test('maxBatch triggers an early export; the timer exports on its own', async () => {
  const t = make({ maxBatch: 3 });
  for (let i = 0; i < 3; i++) await t.span(`s${i}`, L('telemetry'), async () => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sink.spans().length, 3);
  sink.requests.length = 0;
  const timed = make({ intervalMs: 20 });
  await timed.span('t', L('telemetry'), async () => {});
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(sink.spans().length, 1);
  await timed.close!();
});

test('close exports what is left and stops recording', async () => {
  const t = make();
  await t.span('last', L('telemetry'), async () => {});
  await t.close!();
  assert.equal(sink.spans().length, 1);
  await t.span('after', L('telemetry'), async () => {});
  await t.flush!();
  assert.equal(sink.spans().length, 1);
});

test('native().traceparent() names the active span', async () => {
  const t = make() as ReturnType<typeof createOtlpTelemetry>;
  assert.equal(t.native().traceparent(), undefined);
  let seen: string | undefined;
  await t.span('run', L('harness'), async () => { seen = t.native().traceparent(); });
  await t.flush!();
  const run = sink.spans()[0]!;
  assert.equal(seen, `00-${run.traceId}-${run.spanId}-01`);
});

test('warnings carry the origin and a fixed reason, never error text', async () => {
  const warnings: string[] = [];
  const onWarning = (w: Error) => { warnings.push(w.message); };
  process.on('warning', onWarning);
  const leak = 'connect ECONNREFUSED https://admin:hunter2@internal.example/v1/traces authorization: Bearer abc123';
  const reasons: [string, (u: string, i: RequestInit) => Promise<Response>][] = [
    ['network error', async () => { throw new Error(leak); }],
    ['HTTP 502', async () => new Response(leak, { status: 502 })],
    ['invalid response', async () => undefined as unknown as Response],
    ['timeout', (_u, init) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))],
  ];
  try {
    for (const [, fetch] of reasons) {
      const t = createOtlpTelemetry({ endpoint: 'https://collector.example:4318/prefix', headers: { authorization: 'Bearer abc123' }, timeoutMs: 20 }, { fetch });
      await t.span('x', L('telemetry'), async () => {});
      await t.flush!();
    }
    await new Promise((r) => setImmediate(r));
  } finally { process.off('warning', onWarning); }
  assert.equal(warnings.length, 4);
  reasons.forEach(([reason], i) => assert.equal(warnings[i], `OTLP trace export to https://collector.example:4318 failed: ${reason}`));
  assert.ok(warnings.every((w) => !/hunter2|abc123|ECONNREFUSED|internal\.example/.test(w)));
});

test('endpoints with credentials or that are not URLs are rejected at creation', () => {
  assert.throws(() => createOtlpTelemetry({ endpoint: 'https://user:pw@collector.example' }), /must not carry credentials/);
  assert.throws(() => createOtlpTelemetry({ endpoint: 'https://user@collector.example' }), /must not carry credentials/);
  assert.throws(() => createOtlpTelemetry({}, { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://u:p@host:4318' } }), /must not carry credentials/);
  assert.throws(() => createOtlpTelemetry({ endpoint: 'collector:4318' }), /not a valid http\(s\) URL/);
});

test('a remote parent from another process: same trace, parented span, propagated flags and state', async () => {
  const t = make();
  const parent = { parent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', state: 'vendor=a' };
  let inside: ReturnType<typeof t.current>;
  await t.span('gateway.request', L('telemetry'), async () => {
    inside = t.current();
    // A nested span keeps its local parent even when given a remote one.
    await t.span('agent.model.call', L('llm'), async () => {}, { parent: { parent: '00-11111111111111111111111111111111-2222222222222222-01' } });
  }, { parent });
  assert.equal(t.current(), undefined, 'no context outside a span');
  await t.flush!();
  const spans = sink.spans();
  const root = byName(spans, 'gateway.request');
  assert.equal(root.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(root.parentSpanId, '00f067aa0ba902b7');
  assert.equal(byName(spans, 'chat').parentSpanId, root.spanId);
  assert.equal(inside?.parent, `00-${root.traceId}-${root.spanId}-01`);
  assert.equal(inside?.state, 'vendor=a');
});

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';
const joined = async (trace: { parent: string; state?: string }) => {
  sink.requests.length = 0;
  const t = make();
  let inside: ReturnType<typeof t.current>;
  await t.span('root', L('telemetry'), async () => { inside = t.current(); }, { parent: trace });
  await t.flush!();
  const root = sink.spans()[0]!;
  return { root, inside: inside!, joined: root.traceId === TRACE && root.parentSpanId === SPAN };
};

test('a malformed remote parent starts a new trace', async () => {
  const bad = [
    'garbage', '', `00-${TRACE}-${SPAN}`, `00-${TRACE}-${SPAN}-01-extra`, `00-${TRACE}-${SPAN}-01-`,
    `00-${TRACE.toUpperCase()}-${SPAN}-01`, `00-${TRACE}-${SPAN.toUpperCase()}-01`, `0G-${TRACE}-${SPAN}-01`, `00-${TRACE}-${SPAN}-0G`,
    `00-${TRACE.slice(1)}-${SPAN}-01`, `00-${TRACE}0-${SPAN}-01`, `00-${TRACE}-${SPAN.slice(1)}-01`, `00-${TRACE}-${SPAN}0-01`, `00-${TRACE}-${SPAN}-1`,
    `ff-${TRACE}-${SPAN}-01`, `00-${'0'.repeat(32)}-${SPAN}-01`, `00-${TRACE}-${'0'.repeat(16)}-01`,
    ` 00-${TRACE}-${SPAN}-01`, `00-${TRACE}-${SPAN}-01\n`, `00_${TRACE}_${SPAN}_01`,
  ];
  for (const parent of bad) {
    const r = await joined({ parent });
    assert.equal(r.joined, false, JSON.stringify(parent));
    assert.equal(r.root.parentSpanId, undefined, JSON.stringify(parent));
    assert.match(r.root.traceId, /^[0-9a-f]{32}$/);
  }
});

test('a future version with more fields is accepted and re-emitted as version 00', async () => {
  const r = await joined({ parent: `01-${TRACE}-${SPAN}-01-extra-fields` });
  assert.equal(r.joined, true);
  assert.equal(r.inside.parent, `00-${TRACE}-${r.root.spanId}-01`);
  assert.equal((await joined({ parent: `01-${TRACE}-${SPAN}-01` })).joined, true);
  assert.equal((await joined({ parent: `01-${TRACE}-${SPAN}01-x` })).joined, false, 'extra fields follow a dash');
});

test('flags are kept', async () => {
  const r = await joined({ parent: `00-${TRACE}-${SPAN}-00` });
  assert.equal(r.inside.parent, `00-${TRACE}-${r.root.spanId}-00`);
});

test('tracestate: valid lists are kept; oversize, too many members and malformed ones are dropped, the trace still joins', async () => {
  const parent = `00-${TRACE}-${SPAN}-01`;
  const members = (n: number) => Array.from({ length: n }, (_, i) => `k${i}=v`).join(',');
  const good = ['vendor=a', 'a=1,b=2', 'a=1 , b=2', 'tenant@sys=value with spaces', members(32), `k=${'v'.repeat(256)}`];
  for (const state of good) assert.equal((await joined({ parent, state })).inside.state, state, state);
  const bad = [
    '', members(33), `k=${'v'.repeat(600)}`, `${'a'.repeat(300)}=1`, 'novalue', '=v', 'UPPER=1', '1abc=v', 'a=1,a=2', 'a=b=c', 'a="x",b', 'k=v\u0001', 'k=caf\u00e9', 'a=1;b=2',
    `k=${'v'.repeat(257)}`, 'a@b@c=1', `${'t'.repeat(242)}@sys=1`, 'tenant@SYS=1',
  ];
  for (const state of bad) {
    const r = await joined({ parent, state });
    assert.equal(r.joined, true, state);
    assert.equal(r.inside.state, undefined, JSON.stringify(state));
  }
});

test('an invalid parent never fails the run', async () => {
  const t = make();
  for (const trace of [{ parent: undefined as unknown as string }, { parent: 5 as unknown as string }, { parent: `00-${TRACE}-${SPAN}-01`, state: 7 as unknown as string }, null as never]) {
    assert.equal(await t.span('root', L('telemetry'), async () => 1, { parent: trace }), 1);
  }
});

for (const status of [307, 308]) {
  test(`a ${status} redirect is refused: telemetry and headers never reach the other host`, async () => {
    const r = await redirecting(status);
    const warnings: string[] = [];
    const onWarning = (w: Error) => { warnings.push(w.message); };
    process.on('warning', onWarning);
    try {
      const t = createOtlpTelemetry({ endpoint: r.url, headers: { authorization: 'Bearer abc123' }, intervalMs: 60_000, captureContent: true });
      await t.span('x', L('telemetry'), async () => {});
      await t.flush!();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('warning', onWarning);
      await r.close();
    }
    assert.deepEqual(r.hits, []);
    assert.ok(warnings.includes(`OTLP trace export to ${r.url} failed: redirects are not followed (HTTP ${status})`), warnings.join('; '));
  });
}
