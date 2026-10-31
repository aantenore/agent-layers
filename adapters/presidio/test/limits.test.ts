import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, limitFindings, limitList, noopTelemetry } from '@agent-layers/core';
import { adapter, createPresidioGuard } from '../src/index.ts';
import { LIMITS } from '../src/limits.ts';

const ctx = { name: 'presidio', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const base = { analyzerUrl: 'http://x', anonymizerUrl: 'http://x' };
const input = { stage: 'input' as const, text: 'hello', agent: 'a', runId: 'r' };
const hang = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));

test('timeoutMs takes effect; unbounded sets no timer', async () => {
  const slow = createPresidioGuard({ ...base, timeoutMs: 20 }, { fetch: hang });
  assert.equal((await slow.check(input)).reason, 'presidio unavailable: timeout');
  const seen: { signal?: AbortSignal | null } = {};
  const probe = async (_url: string, init: RequestInit) => { seen.signal = init.signal; return Response.json({}); };
  await createPresidioGuard({ ...base, timeoutMs: 'unbounded' }, { fetch: probe }).check(input);
  assert.equal(seen.signal, undefined, 'no timeout signal when unbounded');
  await createPresidioGuard({ ...base, timeoutMs: 5000 }, { fetch: probe }).check(input);
  assert.ok(seen.signal, 'a timeout signal when bounded');
});

test('maxResponseBytes bounds the answer, declared or streamed; a larger one blocks', async () => {
  const big = async () => new Response(JSON.stringify([{ pad: 'x'.repeat(2048) }]));
  assert.deepEqual(await createPresidioGuard({ ...base, maxResponseBytes: 1024 }, { fetch: big }).check(input), { action: 'block', reason: 'presidio unavailable: response too large' });
  const stream = async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode(' '.repeat(512))); c.enqueue(new TextEncoder().encode('[]')); c.close(); } }));
  assert.equal((await createPresidioGuard({ ...base, maxResponseBytes: 1024 }, { fetch: stream }).check(input)).reason, 'presidio unavailable: response too large');
  assert.deepEqual(await createPresidioGuard({ ...base, maxResponseBytes: 'unbounded' }, { fetch: stream }).check(input), { action: 'allow' });
  assert.deepEqual(await createPresidioGuard(base, { fetch: stream }).check(input), { action: 'allow' }, 'default 1 MiB');
});

test('the production tier fails an unbounded response size', () => {
  const findings = limitFindings(limitList(LIMITS), { options: { ...base, maxResponseBytes: 'unbounded' } }, 'production');
  assert.ok(findings.some((f) => f.path === 'options.maxResponseBytes' && f.severity === 'fail'));
  assert.equal(LIMITS.maxResponseBytes.default, 1_048_576);
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  await registry.create('GuardPort', 'presidio', { ...base, timeoutMs: '2500' }, ctx);
  await registry.create('GuardPort', 'presidio', { ...base, timeoutMs: 'unbounded' }, ctx);
  await registry.create('GuardPort', 'presidio', { ...base, maxResponseBytes: '2048' }, ctx);
  for (const bad of [0, -5, 'soon']) {
    await assert.rejects(registry.create('GuardPort', 'presidio', { ...base, timeoutMs: bad }, ctx), /timeoutMs/, String(bad));
    await assert.rejects(registry.create('GuardPort', 'presidio', { ...base, maxResponseBytes: bad }, ctx), /maxResponseBytes/, String(bad));
  }
});
