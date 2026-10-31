import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createOtlpTelemetry, type OtlpOptions } from '../src/index.ts';
import { attr, collector, type Collector, type OtlpSpan } from './collector.ts';

let sink: Collector;
before(async () => { sink = await collector(); });
beforeEach(() => { sink.requests.length = 0; sink.failWith(undefined); });
after(() => sink.close());

const make = (o: OtlpOptions = {}) => createOtlpTelemetry({ endpoint: sink.url, intervalMs: 60_000, ...o });
const L = (layer: 'harness' | 'llm' | 'guardrail' | 'tool' | 'knowledge' | 'telemetry', extra: Record<string, string | number | boolean> = {}) => ({ 'agent.layer': layer, ...extra }) as { 'agent.layer': typeof layer };
const byName = (spans: OtlpSpan[], name: string) => spans.find((s) => s.name === name)!;

test('spans started inside a span are its children; one trace per run', async () => {
  const t = make();
  await t.span('invoke_agent', L('harness', { 'gen_ai.agent.name': 'support' }), async () => {
    await t.span('guard.check', L('guardrail'), async () => {});
    await t.span('chat', L('llm', { 'gen_ai.request.model': 'm1' }), async () => {
      await t.span('inner', L('telemetry'), async () => {});
    });
  });
  await t.flush!();
  const spans = sink.spans();
  const run = byName(spans, 'invoke_agent support');
  const guard = byName(spans, 'guard.check');
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
  const run = (id: string, delay: number) => t.span('invoke_agent', L('harness', { 'run.id': id }), async () => {
    await new Promise((r) => setTimeout(r, delay));
    await t.span('chat', L('llm', { 'run.id': id }), async () => { await new Promise((r) => setTimeout(r, delay)); });
  });
  await Promise.all([run('a', 20), run('b', 5), run('c', 12)]);
  await t.flush!();
  const spans = sink.spans();
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 3);
  for (const chat of spans.filter((s) => s.name === 'chat')) {
    const parent = spans.find((s) => s.spanId === chat.parentSpanId)!;
    assert.equal(attr(parent, 'run.id'), attr(chat, 'run.id'));
    assert.equal(parent.traceId, chat.traceId);
  }
});

test('siblings that run in parallel share the parent', async () => {
  const t = make();
  await t.span('invoke_agent', L('harness'), () => Promise.all([
    t.span('knowledge.search', L('knowledge', { 'knowledge.source': 'a' }), async () => {}),
    t.span('knowledge.search', L('knowledge', { 'knowledge.source': 'b' }), async () => {}),
  ]));
  await t.flush!();
  const spans = sink.spans();
  const run = byName(spans, 'invoke_agent');
  assert.deepEqual(spans.filter((s) => s.name === 'knowledge.search').map((s) => s.parentSpanId), [run.spanId, run.spanId]);
});

test('every span carries agent.layer, timing is ordered, kinds follow the operation', async () => {
  const t = make();
  await t.span('invoke_agent', L('harness'), async () => {
    await t.span('chat', L('llm', { 'gen_ai.operation.name': 'chat' }), async () => { await new Promise((r) => setTimeout(r, 5)); });
    await t.span('execute_tool', L('tool', { 'gen_ai.operation.name': 'execute_tool' }), async () => {});
  });
  await t.flush!();
  for (const s of sink.spans()) {
    assert.ok(attr(s, 'agent.layer'), `${s.name} has agent.layer`);
    assert.ok(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano));
  }
  assert.equal(byName(sink.spans(), 'chat').kind, 3);
  assert.equal(byName(sink.spans(), 'execute_tool').kind, 1);
});

test('names follow the GenAI conventions, and can be left plain', async () => {
  const run = async (o: OtlpOptions) => {
    sink.requests.length = 0;
    const t = make(o);
    await t.span('execute_tool', L('tool', { 'gen_ai.tool.name': 'crm__get' }), async () => {});
    await t.flush!();
    return sink.spans()[0]!.name;
  };
  assert.equal(await run({}), 'execute_tool crm__get');
  assert.equal(await run({ semconvNames: false }), 'execute_tool');
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
  const content = { 'gen_ai.input.messages': '[{"role":"user"}]', 'gen_ai.tool.call.arguments': '{"id":1}', 'policy.reason': 'denied by policy', 'knowledge.query': 'salary of bob' };
  const run = async (o: OtlpOptions) => {
    sink.requests.length = 0;
    const t = make(o);
    await t.span('x', L('tool', { ...content, 'tool.source': 'crm' }), async (s) => { s.setAttributes({ 'gen_ai.tool.call.result': 'rows' }); throw new Error('timeout talking to crm'); }).catch(() => {});
    await t.flush!();
    return sink.spans()[0]!;
  };
  const off = await run({});
  for (const k of [...Object.keys(content), 'gen_ai.tool.call.result']) assert.equal(attr(off, k), undefined, k);
  assert.equal(attr(off, 'tool.source'), 'crm');
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
    t.event('knowledge.error', L('knowledge', { 'knowledge.source': 'docs' }));
    s.addEvent('step', { n: 2 });
  });
  t.event('lonely', L('telemetry'));
  await t.flush!();
  const run = byName(sink.spans(), 'run');
  assert.deepEqual(run.events!.map((e) => e.name), ['knowledge.error', 'step']);
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
  await t.span('invoke_agent', L('harness', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'support' }), async (run) => {
    await t.span('chat', L('llm', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'm1' }), async () => {
      t.metric('gen_ai.client.token.usage', 100, L('llm', { 'gen_ai.token.type': 'input' }));
      t.metric('gen_ai.client.token.usage', 20, L('llm', { 'gen_ai.token.type': 'output' }));
    });
    t.metric('agent.guardrail.actions', 1, L('guardrail', { 'guard.action': 'redact' }));
    t.metric('agent.guardrail.actions', 1, L('guardrail', { 'guard.action': 'redact' }));
    run.setAttributes({ 'run.status': 'completed' });
  });
  await t.flush!();
  const metrics = sink.metrics();
  const named = (n: string) => metrics.find((m) => m.name === n)!;
  const tokens = named('gen_ai.client.token.usage');
  assert.equal(tokens.unit, '{token}');
  assert.equal(tokens.histogram.aggregationTemporality, 2);
  const input = tokens.histogram.dataPoints.find((p: any) => p.attributes.some((a: any) => a.key === 'gen_ai.token.type' && a.value.stringValue === 'input'));
  assert.equal(input.count, '1');
  assert.equal(input.sum, 100);
  assert.equal(input.bucketCounts.length, input.explicitBounds.length + 1);
  assert.equal(input.bucketCounts.map(Number).reduce((a: number, b: number) => a + b), 1);
  assert.ok(input.attributes.some((a: any) => a.key === 'agent.layer'));
  const guard = named('agent.guardrail.actions').sum;
  assert.equal(guard.isMonotonic, true);
  assert.equal(guard.dataPoints[0].asDouble, 2);
  assert.equal(named('gen_ai.client.operation.duration').histogram.dataPoints[0].count, '1');
  assert.equal(named('agent.runs').sum.dataPoints[0].attributes.find((a: any) => a.key === 'run.status').value.stringValue, 'completed');

  t.metric('agent.guardrail.actions', 1, L('guardrail', { 'guard.action': 'redact' }));
  await t.flush!();
  const again = sink.metrics().filter((m) => m.name === 'agent.guardrail.actions').at(-1);
  assert.equal(again.sum.dataPoints[0].asDouble, 3, 'cumulative totals');
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
