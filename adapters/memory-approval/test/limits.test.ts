import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleQuestion } from '@agent-layers/conformance';
import { AdapterRegistry, noopTelemetry } from '@agent-layers/core';
import { adapter, createMemoryApproval } from '../src/index.ts';

const ctx = { name: 'approval', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const req = { question: sampleQuestion({ risk: 'write' }), agent: 'a', runId: 'r' };

test('ttlMs sets an expiry; unset or unbounded leaves approvals open', async () => {
  assert.ok((await createMemoryApproval({ ttlMs: 60_000 }).request(req)).request.expiresAt);
  assert.equal((await createMemoryApproval().request(req)).request.expiresAt, undefined);
  assert.equal((await createMemoryApproval({ ttlMs: 'unbounded' }).request(req)).request.expiresAt, undefined);
});

test('limits from ${env:...} are coerced to numbers; out-of-range values are rejected', async () => {
  const registry = new AdapterRegistry().register(adapter);
  await registry.create('ApprovalPort', 'memory-approval', { ttlMs: '30000' }, ctx);
  await registry.create('ApprovalPort', 'memory-approval', { ttlMs: 'unbounded' }, ctx);
  for (const bad of [0, -1]) await assert.rejects(registry.create('ApprovalPort', 'memory-approval', { ttlMs: bad }, ctx), /ttlMs/, String(bad));
});
