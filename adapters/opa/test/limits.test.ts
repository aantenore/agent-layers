import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry } from '@agent-layers/core';
import { adapter, createOpa } from '../src/index.ts';
import { pdp, send } from './helpers.ts';

const ctx = { name: 'opa', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const request = { subject: { type: 'agent', id: 'a', properties: { authenticated: true } }, action: { name: 'call' }, resource: { type: 'tool', id: 'notes__save' } };

test('maxReasonChars and maxResponseBytes take effect', async () => {
  const s = await pdp((_b, _h, res) => send(res, 200, { result: { allow: true, reason: 'abcdefghij' } }));
  try {
    assert.deepEqual((await createOpa({ url: s.url, maxReasonChars: 4 }).evaluate(request)).context, { reason: 'abcd' });
    assert.equal((await createOpa({ url: s.url }).evaluate(request)).context?.reason, 'abcdefghij');
    await assert.rejects(createOpa({ url: s.url, maxResponseBytes: 10 }).evaluate(request), /too large/);
    await createOpa({ url: s.url, maxResponseBytes: 'unbounded' }).evaluate(request);
  } finally {
    await s.close();
  }
});

test('timeoutMs takes effect', async () => {
  const s = await pdp(() => new Promise(() => {}));
  try {
    await assert.rejects(createOpa({ url: s.url, timeoutMs: 100 }).evaluate(request), /timed out after 100ms/);
  } finally {
    await s.close();
  }
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  const url = 'http://127.0.0.1:9';
  await registry.create('AuthorizationPort', 'opa', { url, timeoutMs: '2500', maxResponseBytes: '2000000', maxReasonChars: '100' }, ctx);
  await registry.create('AuthorizationPort', 'opa', { url, timeoutMs: 'unbounded', maxResponseBytes: 'unbounded' }, ctx);
  for (const bad of [{ timeoutMs: 0 }, { maxResponseBytes: -1 }, { maxReasonChars: 0 }, { maxReasonChars: 'unbounded' }]) {
    await assert.rejects(registry.create('AuthorizationPort', 'opa', { url, ...bad }, ctx), new RegExp(Object.keys(bad)[0]!), JSON.stringify(bad));
  }
});
