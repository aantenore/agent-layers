import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry } from '@agent-layers/core';
import { adapter, createPresidioGuard } from '../src/index.ts';

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

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  await registry.create('GuardPort', 'presidio', { ...base, timeoutMs: '2500' }, ctx);
  await registry.create('GuardPort', 'presidio', { ...base, timeoutMs: 'unbounded' }, ctx);
  for (const bad of [0, -5, 'soon']) {
    await assert.rejects(registry.create('GuardPort', 'presidio', { ...base, timeoutMs: bad }, ctx), /timeoutMs/, String(bad));
  }
});
