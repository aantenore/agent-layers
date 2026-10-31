import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, limitFindings, limitList, noopTelemetry } from '@agent-layers/core';
import { adapter, createLlmGuard } from '../src/index.ts';
import { LIMITS } from '../src/limits.ts';

const ctx = { name: 'llm-guard', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const base = { url: 'http://x' };
const input = { stage: 'input' as const, text: 'hello', agent: 'a', runId: 'r' };
const hang = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));

test('timeoutMs takes effect; unbounded sets no timer', async () => {
  const slow = createLlmGuard({ ...base, timeoutMs: 20 }, { fetch: hang });
  assert.equal((await slow.check(input)).reason, 'llm-guard unavailable: timeout');
  const seen: { signal?: AbortSignal | null } = {};
  const probe = async (_url: string, init: RequestInit) => { seen.signal = init.signal; return Response.json({}); };
  await createLlmGuard({ ...base, timeoutMs: 'unbounded' }, { fetch: probe }).check(input);
  assert.equal(seen.signal, undefined, 'no timeout signal when unbounded');
  await createLlmGuard({ ...base, timeoutMs: 5000 }, { fetch: probe }).check(input);
  assert.ok(seen.signal, 'a timeout signal when bounded');
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  await registry.create('GuardPort', 'llm-guard', { ...base, timeoutMs: '2500' }, ctx);
  await registry.create('GuardPort', 'llm-guard', { ...base, timeoutMs: 'unbounded' }, ctx);
  await registry.create('GuardPort', 'llm-guard', { ...base, maxResponseBytes: '2048' }, ctx);
  for (const bad of [0, -5, 'soon']) {
    await assert.rejects(registry.create('GuardPort', 'llm-guard', { ...base, timeoutMs: bad }, ctx), /timeoutMs/, String(bad));
    await assert.rejects(registry.create('GuardPort', 'llm-guard', { ...base, maxResponseBytes: bad }, ctx), /maxResponseBytes/, String(bad));
  }
});

test('the production tier fails an unbounded response size; the default is 1 MiB', () => {
  const findings = limitFindings(limitList(LIMITS), { options: { ...base, maxResponseBytes: 'unbounded' } }, 'production');
  assert.ok(findings.some((f) => f.path === 'options.maxResponseBytes' && f.severity === 'fail'));
  assert.equal(LIMITS.maxResponseBytes.default, 1_048_576);
});
