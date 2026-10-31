import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry, noopTelemetry } from '@agent-layers/core';
import { adapter, type SqliteState } from '../src/index.ts';

const ctx = { name: 'state', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const make = (options: Record<string, unknown>) => new AdapterRegistry().register(adapter).create('StatePort', 'sqlite-state', { path: ':memory:', ...options }, ctx) as Promise<SqliteState>;
const busy = (state: SqliteState) => (state.native().prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;

test('busyTimeoutMs sets the lock wait (numeric string, 0 and unbounded)', async () => {
  const states = [await make({}), await make({ busyTimeoutMs: '1500' }), await make({ busyTimeoutMs: 0 }), await make({ busyTimeoutMs: 'unbounded' })];
  assert.deepEqual(states.map(busy), [5000, 1500, 0, 2 ** 31 - 1]);
  await Promise.all(states.map((s) => s.close()));
});

test('negative or non-numeric values are rejected', async () => {
  await assert.rejects(make({ busyTimeoutMs: -1 }), /busyTimeoutMs/);
  await assert.rejects(make({ busyTimeoutMs: 'long' }), /busyTimeoutMs/);
});
