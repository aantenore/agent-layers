import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleAccess } from '@agent-layers/conformance';
import { createMemoryApproval } from '../src/index.ts';

const req = { access: sampleAccess({ risk: 'write' }), agent: 'a', runId: 'r' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('request creates a pending approval with a unique id', async () => {
  const port = createMemoryApproval();
  const [a, b] = [await port.request(req), await port.request(req)];
  assert.equal(a.status, 'pending');
  assert.notEqual(a.id, b.id);
  assert.deepEqual(await port.get(a.id), a);
  assert.equal(await port.get('missing'), undefined);
});

test('decide records who and why, and cannot be repeated', async () => {
  const port = createMemoryApproval();
  const a = await port.request(req);
  const decided = await port.decide(a.id, { approved: false, by: 'alice', reason: 'too risky' });
  assert.deepEqual([decided.status, decided.decidedBy, decided.reason], ['denied', 'alice', 'too risky']);
  assert.equal((await port.get(a.id))?.status, 'denied');
  await assert.rejects(port.decide(a.id, { approved: true }), /already denied/);
  await assert.rejects(port.decide('missing', { approved: true }), /unknown approval/);
});

test('wait resolves as soon as the approval is decided', async () => {
  const port = createMemoryApproval();
  const a = await port.request(req);
  const waiting = port.wait(a.id, { timeoutMs: 5000 });
  await port.decide(a.id, { approved: true, by: 'bob' });
  assert.equal((await waiting).status, 'approved');
  assert.equal((await port.wait(a.id)).status, 'approved');
});

test('wait returns the pending approval on timeout and rejects unknown ids', async () => {
  const port = createMemoryApproval();
  const a = await port.request(req);
  assert.equal((await port.wait(a.id, { timeoutMs: 20 })).status, 'pending');
  await assert.rejects(port.wait('missing'), /unknown approval/);
});

test('wait rejects when the signal aborts', async () => {
  const port = createMemoryApproval();
  const a = await port.request(req);
  const ac = new AbortController();
  const waiting = port.wait(a.id, { signal: ac.signal });
  ac.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
});

test('ttl expires pending approvals', async () => {
  const port = createMemoryApproval({ ttlMs: 30 });
  const a = await port.request(req);
  assert.ok(a.request.expiresAt);
  assert.equal((await port.wait(a.id)).status, 'expired');
  assert.equal((await port.get(a.id))?.status, 'expired');
  await sleep(0);
  await assert.rejects(port.decide(a.id, { approved: true }), /already expired/);
});
