import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry } from '@agent-layers/core';
import { adapter, createOtlpTelemetry, type FetchLike } from '../src/index.ts';

const ctx = { name: 'otlp', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const layer = { 'agent.layer': 'harness' } as const;

function recorder() {
  const bodies: { resourceSpans: { scopeSpans: { spans: { name: string; status?: { message?: string } }[] }[] }[] }[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith('/v1/traces')) { bodies.push(JSON.parse(String(init.body))); signals.push(init.signal); }
    return new Response(null, { status: 200 });
  };
  const spans = () => bodies.flatMap((b) => b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
  return { fetch, spans, signals };
}

test('maxQueue keeps only the newest spans while an export is in flight', async () => {
  const bodies: string[][] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith('/v1/traces')) {
      bodies.push((JSON.parse(String(init.body)).resourceSpans[0].scopeSpans[0].spans as { name: string }[]).map((s) => s.name));
      await gate;
    }
    return new Response(null, { status: 200 });
  };
  const t = createOtlpTelemetry({ endpoint: 'http://localhost:4318', intervalMs: 60_000, maxBatch: 2, maxQueue: 4, metrics: false }, { fetch });
  for (let i = 0; i < 12; i++) await t.span(`s${i}`, layer, async () => {});
  release();
  await t.flush!();
  await t.close!();
  assert.deepEqual(bodies, [['s0', 's1'], ['s8', 's9', 's10', 's11']]);
});

test('errorMessageChars cuts the exported error message', async () => {
  const rec = recorder();
  const t = createOtlpTelemetry({ endpoint: 'http://localhost:4318', intervalMs: 60_000, captureContent: true, errorMessageChars: 6, metrics: false }, { fetch: rec.fetch });
  await assert.rejects(t.span('boom', layer, async () => { throw new Error('0123456789'); }));
  await t.flush!();
  await t.close!();
  assert.equal(rec.spans()[0]!.status?.message, '012345');
});

test('timeoutMs sets the request deadline; unbounded sets none', async () => {
  const bounded = recorder();
  const a = createOtlpTelemetry({ endpoint: 'http://localhost:4318', intervalMs: 60_000, timeoutMs: 1234, metrics: false }, { fetch: bounded.fetch });
  await a.span('s', layer, async () => {});
  await a.close!();
  assert.ok(bounded.signals[0] instanceof AbortSignal);
  const open = recorder();
  const b = createOtlpTelemetry({ endpoint: 'http://localhost:4318', intervalMs: 60_000, timeoutMs: 'unbounded', metrics: false }, { fetch: open.fetch });
  await b.span('s', layer, async () => {});
  await b.close!();
  assert.equal(open.signals[0], undefined);
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  const make = async (options: Record<string, unknown>) => {
    const t = await registry.create('TelemetryPort', 'otlp', { endpoint: 'http://localhost:4318', ...options }, ctx);
    await t.close?.();
  };
  await make({ intervalMs: '5000', maxBatch: '100', maxQueue: '800', timeoutMs: '3000', errorMessageChars: '50' });
  await make({ timeoutMs: 'unbounded', maxQueue: 'unbounded' });
  await assert.rejects(make({ timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(make({ maxBatch: 'unbounded' }), /maxBatch/);
  await assert.rejects(make({ intervalMs: 0 }), /intervalMs/);
  await assert.rejects(make({ maxBatch: 100, maxQueue: 50 }), /maxQueue/);
});
