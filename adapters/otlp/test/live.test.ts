import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, resolveProfile, type StackConfig } from '@agent-layers/core';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { adapter as presidio } from '@agent-layers/adapter-presidio';
import { adapter as otlp, createOtlpTelemetry } from '../src/index.ts';

// Live contract tests against the reference setups: reference/telemetry (OpenTelemetry Collector 0.164, Jaeger 2.22:
// only those two services are needed) and reference/guardrail (Presidio 2.2.362). Each test skips when its services
// are not up.
const collectorUrl = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318').replace(/\/$/, '');
const jaegerUrl = (process.env.JAEGER_UI ?? 'http://localhost:16686').replace(/\/$/, '');
const prometheusUrl = process.env.OTEL_PROMETHEUS_URL ?? 'http://localhost:8889/metrics';
const analyzerUrl = process.env.PRESIDIO_ANALYZER_URL ?? 'http://localhost:5002';
const anonymizerUrl = process.env.PRESIDIO_ANONYMIZER_URL ?? 'http://localhost:5001';

const reachable = (url: string) => fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
const telemetryUp = (await Promise.all([jaegerUrl, collectorUrl].map(reachable))).every(Boolean);
const presidioUp = (await Promise.all([`${analyzerUrl}/health`, `${anonymizerUrl}/health`].map(reachable))).every(Boolean);
const needsTelemetry = { skip: telemetryUp ? false : 'collector or Jaeger not reachable (make up LAYER=telemetry)' };
const needsBoth = { skip: telemetryUp && presidioUp ? false : 'collector, Jaeger or Presidio not reachable (make up LAYER=telemetry, LAYER=guardrail)' };

interface JaegerSpan { traceId: string; spanId: string; parentSpanId?: string; name: string; attributes: { key: string; value: { stringValue?: string } }[] }
const tag = (s: JaegerSpan, key: string) => s.attributes.find((a) => a.key === key)?.value.stringValue;

/** Polls Jaeger (v2 query API, OTLP-shaped) until the service has at least `min` spans. */
async function traceOf(service: string, min: number): Promise<JaegerSpan[]> {
  const day = 24 * 3600 * 1000;
  for (let i = 0; i < 30; i++) {
    const q = new URLSearchParams({
      'query.service_name': service,
      'query.start_time_min': new Date(Date.now() - day).toISOString(),
      'query.start_time_max': new Date(Date.now() + day).toISOString(),
      'query.search_depth': '5',
    });
    const res = await fetch(`${jaegerUrl}/api/v3/traces?${q}`);
    if (res.ok) {
      const spans = ((await res.json()) as any).result?.resourceSpans?.flatMap((rs: any) => rs.scopeSpans.flatMap((ss: any) => ss.spans)) as JaegerSpan[] | undefined;
      if (spans && spans.length >= min) return spans;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.fail(`no trace for ${service} in Jaeger`);
}

test('live: nested spans and metrics reach Jaeger and the collector', needsTelemetry, async () => {
  const service = `otlp-adapter-${Date.now()}`;
  const t = createOtlpTelemetry({ endpoint: collectorUrl, serviceName: service, intervalMs: 500 });
  await t.span('agent.run', { 'agent.layer': 'harness', 'agent.name': 'live' }, async (run) => {
    await t.span('agent.guard.check', { 'agent.layer': 'guardrail', 'agent.guard.action': 'allow' }, async () => {});
    await t.span('agent.model.call', { 'agent.layer': 'llm', 'agent.model.requested': 'mock' }, async () => {
      t.metric('agent.model.tokens', 12, { 'agent.layer': 'llm', 'agent.tokens.kind': 'input', 'agent.model.used': 'mock' });
    });
    t.metric('agent.guard.actions', 1, { 'agent.layer': 'guardrail', 'agent.guard.action': 'redact' });
    run.setAttributes({ 'agent.run.status': 'completed' });
  });
  await t.close!();

  const spans = await traceOf(service, 3);
  const run = spans.find((s) => s.name === 'invoke_agent live')!;
  assert.ok(run, 'run span');
  assert.equal(tag(run, 'agent.layer'), 'harness');
  for (const name of ['agent.guard.check', 'chat mock']) {
    const child = spans.find((s) => s.name === name)!;
    assert.ok(child, name);
    assert.equal(child.parentSpanId, run.spanId, `${name} is a child of the run`);
    assert.equal(child.traceId, run.traceId);
  }
  assert.equal(tag(spans.find((s) => s.name === 'agent.guard.check')!, 'agent.layer'), 'guardrail');
  assert.equal(tag(spans.find((s) => s.name === 'chat mock')!, 'agent.layer'), 'llm');

  let text = '';
  for (let i = 0; i < 20 && !(text.includes('gen_ai_client_token_usage') && text.includes('agent_guard_actions') && text.includes(service)); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    text = await (await fetch(prometheusUrl)).text();
  }
  for (const name of ['gen_ai_client_token_usage', 'agent_guard_actions', 'gen_ai_client_operation_duration', 'agent_runs']) assert.ok(text.includes(name), name);
  assert.match(text, /agent_guard_actions\S*\{[^}]*agent_layer="guardrail"/);
});

test('live: a composed stack redacts an email before the model and traces guard and model under the run', needsBoth, async () => {
  const service = `otlp-stack-${Date.now()}`;
  const config: StackConfig = {
    layers: {
      model: { adapter: 'mock-model' },
      runtime: { adapter: 'basic-runtime' },
      guardrails: [{ adapter: 'presidio', options: { analyzerUrl, anonymizerUrl, entities: ['EMAIL_ADDRESS'] } }],
      telemetry: [{ adapter: 'otlp', options: { endpoint: collectorUrl, serviceName: service, intervalMs: 500 } }],
    },
    agents: { assistant: { instructions: 'Answer briefly.', model: 'mock', tools: [] } },
  };
  const stack = await compose(resolveProfile(config), { adapters: [mockModel, basicRuntime, presidio, otlp] });
  const result = await (await stack.agent('assistant')).run('My email is jane.doe@example.com, remember it');
  await stack.close();

  assert.equal(result.status, 'completed');
  assert.ok(!result.output.includes('jane.doe@example.com'), 'the model never saw the address');
  assert.ok(result.output.includes('<EMAIL_ADDRESS>'), result.output);

  const spans = await traceOf(service, 4);
  const run = spans.find((s) => s.name === 'invoke_agent assistant')!;
  assert.ok(run, 'run span');
  const children = spans.filter((s) => s.parentSpanId === run.spanId);
  assert.ok(children.some((s) => s.name === 'agent.guard.check' && tag(s, 'agent.guard.action') === 'redact' && tag(s, 'agent.layer') === 'guardrail'), 'guard span under the run');
  assert.ok(children.some((s) => s.name === 'chat mock' && tag(s, 'agent.layer') === 'llm'), 'model span under the run');
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 1, 'one trace');
  assert.ok(!JSON.stringify(spans).includes('jane.doe'), 'no content exported');
});
