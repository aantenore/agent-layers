import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reinloop } from '../../../lib/reinloop.mjs';
import { reachable } from '../../../lib/wait.mjs';

try { process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env')); } catch { /* .env is optional */ }

const otlp = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318').replace(/\/$/, '');
const langfuse = (process.env.LANGFUSE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const jaeger = (process.env.JAEGER_UI ?? 'http://localhost:16686').replace(/\/$/, '');
const metricsUrl = process.env.OTEL_PROMETHEUS_URL ?? 'http://localhost:8889/metrics';
const basic = 'Basic ' + Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY ?? 'pk-lf-local'}:${process.env.LANGFUSE_SECRET_KEY ?? 'sk-lf-local'}`).toString('base64');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value, or fails after `timeoutMs`. */
async function poll(label, fn, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(2000);
  }
  assert.fail(`${label}: not found within ${timeoutMs} ms (${last instanceof Error ? last.message : 'no match'})`);
}

/** Returns undefined when everything is up, otherwise the reason to skip. */
async function skipReason() {
  for (const [name, url] of [['collector', otlp], ['Jaeger', jaeger], ['Langfuse', `${langfuse}/api/public/health`], ['collector metrics', metricsUrl]]) {
    if (!(await reachable(url, { timeoutMs: 15_000 }))) return `${name} not reachable at ${url}; run "make up LAYER=telemetry"`;
  }
}

/** One agent run (mock model, one tool call) through the reinloop otlp sink with metrics. Returns the service name. */
async function emitRun(serviceName) {
  const { run, mockProvider, otlpSink } = reinloop;
  const sink = otlpSink({ endpoint: otlp, serviceName, metrics: true, intervalMs: 500 });
  const tool = { name: 'lookup', description: 'lookup', risk: 'read', layer: 'knowledge', schema: { type: 'object' }, run: () => 'found' };
  const agent = { name: 'telemetry-agent', model: { provider: mockProvider([{ toolCalls: [{ name: 'lookup' }] }, { text: 'done' }]), model: 'mock-1' }, tools: [tool] };
  const result = await run(agent, 'go', { sinks: [sink], identity: { subject: 'telemetry-user', kind: 'user' } });
  await sink.close();
  assert.equal(result.status, 'completed');
  return result;
}

test('telemetry: spans reach Jaeger and Langfuse, metrics reach the collector endpoint', { timeout: 240_000 }, async (t) => {
  const reason = await skipReason();
  if (reason) return t.skip(`SKIPPED: ${reason}`);

  const serviceName = `telemetry-test-${Date.now()}`;
  const result = await emitRun(serviceName);

  await t.test('Jaeger has the trace with agent.layer attributes', async () => {
    // Jaeger v2 query API (v3, OTLP-shaped). The v1 /api/traces endpoint is gone.
    const spans = await poll('Jaeger trace', async () => {
      const day = 24 * 3600 * 1000;
      const q = new URLSearchParams({
        'query.service_name': serviceName,
        'query.start_time_min': new Date(Date.now() - day).toISOString(),
        'query.start_time_max': new Date(Date.now() + day).toISOString(),
        'query.search_depth': '5',
      });
      const res = await fetch(`${jaeger}/api/v3/traces?${q}`);
      if (!res.ok) return undefined;
      const all = (await res.json()).result?.resourceSpans?.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)) ?? [];
      return all.length >= 4 ? all : undefined;
    });
    const tag = (span, key) => span.attributes.find((x) => x.key === key)?.value?.stringValue;
    const span = (prefix) => spans.find((s) => s.name.startsWith(prefix));
    assert.equal(tag(span('invoke_agent'), 'agent.layer'), 'harness');
    assert.equal(tag(span('chat'), 'agent.layer'), 'llm');
    assert.equal(tag(span('execute_tool lookup'), 'agent.layer'), 'knowledge');
    assert.equal(tag(span('invoke_agent'), 'enduser.id'), 'telemetry-user');
  });

  await t.test('Langfuse has the trace', async () => {
    const found = await poll('Langfuse trace', async () => {
      const res = await fetch(`${langfuse}/api/public/traces?limit=50`, { headers: { authorization: basic } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return (body.data ?? []).find((tr) => JSON.stringify(tr).includes(result.runId));
    });
    assert.ok(found);
  });

  await t.test('the collector Prometheus endpoint exposes the metrics', async () => {
    const text = await poll('Prometheus metrics', async () => {
      const body = await (await fetch(metricsUrl)).text();
      return body.includes('agent_runs') && body.includes('gen_ai_client_token_usage') ? body : undefined;
    }, 30_000);
    for (const name of ['agent_tool_calls', 'agent_runs', 'gen_ai_client_operation_duration']) assert.ok(text.includes(name), name);
    assert.match(text, /agent_tool_calls\S*\{[^}]*layer="knowledge"/);
  });
});
