import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleQuestion } from '@agent-layers/conformance';
import { AdapterRegistry, noopTelemetry } from '@agent-layers/core';
import { adapter, type SqliteApproval } from '../src/index.ts';

const ctx = { name: 'approval', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const make = (options: Record<string, unknown>) => new AdapterRegistry().register(adapter).create('ApprovalPort', 'sqlite-approval', { path: ':memory:', ...options }, ctx) as Promise<SqliteApproval>;
const busy = (port: SqliteApproval) => (port.native().prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
const req = { question: sampleQuestion({ risk: 'write' }), agent: 'a', runId: 'r' };

test('busyTimeoutMs sets the lock wait (numeric string, 0 and unbounded)', async () => {
  const ports = [await make({}), await make({ busyTimeoutMs: '1500' }), await make({ busyTimeoutMs: 0 }), await make({ busyTimeoutMs: 'unbounded' })];
  assert.deepEqual(ports.map(busy), [5000, 1500, 0, 2 ** 31 - 1]);
  await Promise.all(ports.map((p) => p.close()));
});

test('ttlMs sets an expiry; unset or unbounded leaves approvals open', async () => {
  const ports = [await make({ ttlMs: 60_000 }), await make({}), await make({ ttlMs: 'unbounded' }), await make({ ttlMs: '30000' })];
  const expiries = await Promise.all(ports.map(async (p) => (await p.request(req)).request.expiresAt));
  assert.deepEqual(expiries.map(Boolean), [true, false, false, true]);
  await Promise.all(ports.map((p) => p.close()));
});

test('pollMs accepts numbers and numeric strings', async () => {
  await Promise.all([await make({ pollMs: 50 }), await make({ pollMs: '200' })].map((p) => p.close()));
});

test('out-of-range or non-numeric values are rejected', async () => {
  for (const bad of [{ busyTimeoutMs: -1 }, { busyTimeoutMs: 'long' }, { ttlMs: 0 }, { ttlMs: -1 }, { pollMs: 0 }, { pollMs: 'unbounded' }]) {
    await assert.rejects(make(bad), new RegExp(Object.keys(bad)[0]!), JSON.stringify(bad));
  }
});
