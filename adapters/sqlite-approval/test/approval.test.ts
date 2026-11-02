import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { sampleQuestion } from '@agent-layers/conformance';
import { createSqliteApproval, SCHEMA_VERSION } from '../src/index.ts';

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'sqlite-approval-')); });
after(() => rm(dir, { recursive: true, force: true }));

const req = { question: sampleQuestion({ risk: 'write' }), agent: 'a', runId: 'r' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const file = (name: string) => join(dir, `${name}.db`);
const fresh = (options = {}) => createSqliteApproval({ path: ':memory:', ...options });

test('request creates a pending approval with a unique id', async () => {
  const port = fresh();
  const [a, b] = [await port.request(req), await port.request(req)];
  assert.equal(a.status, 'pending');
  assert.notEqual(a.id, b.id);
  assert.deepEqual(await port.get(a.id), a);
  assert.equal(await port.get('missing'), undefined);
  await port.close();
});

test('decide records who and why, and cannot be repeated', async () => {
  const port = fresh();
  const a = await port.request(req);
  const decided = await port.decide(a.id, { approved: false, by: 'alice', reason: 'too risky' });
  assert.deepEqual([decided.status, decided.decidedBy, decided.reason], ['denied', 'alice', 'too risky']);
  assert.equal((await port.get(a.id))?.status, 'denied');
  await assert.rejects(port.decide(a.id, { approved: true }), /approval .* is already denied/);
  await assert.rejects(port.decide('missing', { approved: true }), /unknown approval/);
  await port.close();
});

test('wait resolves as soon as the approval is decided, without waiting for a poll', async () => {
  const port = fresh({ pollMs: 60_000 });
  const a = await port.request(req);
  const started = Date.now();
  const waiting = port.wait(a.id, { timeoutMs: 5000 });
  await port.decide(a.id, { approved: true, by: 'bob' });
  assert.equal((await waiting).status, 'approved');
  assert.ok(Date.now() - started < 1000);
  assert.equal((await port.wait(a.id)).status, 'approved');
  await port.close();
});

test('wait returns the pending approval on timeout and rejects unknown ids', async () => {
  const port = fresh();
  const a = await port.request(req);
  assert.equal((await port.wait(a.id, { timeoutMs: 20 })).status, 'pending');
  await assert.rejects(port.wait('missing'), /unknown approval/);
  await port.close();
});

test('wait rejects when the signal aborts', async () => {
  const port = fresh();
  const a = await port.request(req);
  const ac = new AbortController();
  const waiting = port.wait(a.id, { signal: ac.signal });
  ac.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  await port.close();
});

test('a decision taken through another instance of the same file is seen by wait', async () => {
  const [waiter, decider] = [createSqliteApproval({ path: file('shared'), pollMs: 20 }), createSqliteApproval({ path: file('shared') })];
  const a = await waiter.request(req);
  const waiting = waiter.wait(a.id, { timeoutMs: 5000 });
  await sleep(30);
  await decider.decide(a.id, { approved: true, by: 'carol' });
  const seen = await waiting;
  assert.deepEqual([seen.status, seen.decidedBy], ['approved', 'carol']);
  await Promise.all([waiter.close(), decider.close()]);
});

test('approvals survive reopening the file; the file keeps its schema version', async () => {
  const first = createSqliteApproval({ path: file('durable') });
  const a = await first.request({ ...req, key: 'k' });
  const b = await first.request(req);
  await first.decide(b.id, { approved: false, reason: 'no' });
  await first.close();

  const second = createSqliteApproval({ path: file('durable') });
  assert.deepEqual(await second.get(a.id), a);
  assert.deepEqual([(await second.get(b.id))?.status, (await second.get(b.id))?.reason], ['denied', 'no']);
  assert.equal((await second.lookup('k'))?.id, a.id);
  assert.equal((second.native().prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v, SCHEMA_VERSION);
  await second.close();
});

test('lookup finds the latest approval by key; consume lets an approval through once', async () => {
  const port = fresh();
  assert.equal(await port.lookup('k1'), undefined);
  const a = await port.request({ ...req, key: 'k1' });
  assert.equal((await port.lookup('k1'))?.id, a.id);
  assert.equal((await port.lookup('k1', { consume: true }))?.status, 'pending', 'a pending approval is not consumed');
  await port.decide(a.id, { approved: true });
  assert.equal((await port.lookup('k1', { consume: true }))?.status, 'approved');
  assert.equal(await port.lookup('k1'), undefined, 'consumed');
  assert.equal((await port.get(a.id))?.status, 'approved', 'get still shows the decision');
  const d = await port.request({ ...req, key: 'k2' });
  await port.decide(d.id, { approved: false });
  assert.equal((await port.lookup('k2', { consume: true }))?.status, 'denied');
  assert.equal((await port.lookup('k2', { consume: true }))?.status, 'denied', 'a denial stays');
  const first = await port.request({ ...req, key: 'k3' });
  await port.decide(first.id, { approved: false });
  const next = await port.request({ ...req, key: 'k3' });
  assert.notEqual(next.id, first.id, 'a decided request is not reused');
  assert.equal((await port.lookup('k3'))?.id, next.id, 'the latest wins');
  await port.close();
});

test('consume is atomic across instances sharing a file', async () => {
  const ports = [1, 2, 3, 4].map(() => createSqliteApproval({ path: file('atomic') }));
  const a = await ports[0]!.request({ ...req, key: 'once' });
  await ports[0]!.decide(a.id, { approved: true });
  const results = await Promise.all(ports.flatMap((p) => [p.lookup('once', { consume: true }), p.lookup('once', { consume: true })]));
  assert.equal(results.filter((r) => r?.status === 'approved').length, 1);
  assert.equal(await ports[0]!.lookup('once'), undefined);
  await Promise.all(ports.map((p) => p.close()));
});

test('ttl expires pending approvals, derived on read', async () => {
  const port = fresh({ ttlMs: 30 });
  const a = await port.request({ ...req, key: 'e' });
  assert.ok(a.request.expiresAt);
  assert.equal((await port.wait(a.id)).status, 'expired');
  assert.equal((await port.get(a.id))?.status, 'expired');
  assert.equal((await port.lookup('e'))?.status, 'expired');
  await assert.rejects(port.decide(a.id, { approved: true }), /already expired/);
  await port.close();
});

test('an explicit expiresAt is honoured', async () => {
  const port = fresh();
  const a = await port.request({ ...req, expiresAt: new Date(Date.now() + 20).toISOString() });
  assert.equal(a.status, 'pending');
  await sleep(40);
  assert.equal((await port.get(a.id))?.status, 'expired');
  await port.close();
});

test('the stored question never carries a caller credential', async () => {
  const path = file('credential');
  const port = createSqliteApproval({ path });
  const q = sampleQuestion({ risk: 'write' });
  const leaked = { ...req, question: { ...q, caller: Object.assign({ ...q.caller }, { credential: 'raw-token' }) } };
  const a = await port.request(leaked);
  assert.ok(!JSON.stringify(a).includes('raw-token'));
  assert.ok(!JSON.stringify(await port.get(a.id)).includes('raw-token'));
  const rows = port.native().prepare('SELECT approval FROM approvals').all();
  assert.ok(!JSON.stringify(rows).includes('raw-token'), 'not written to the file');
  assert.equal((leaked.question.caller as { credential?: string }).credential, 'raw-token', 'the caller object is not changed');
  await port.close();
});

test('close wakes waiters; later operations fail', async () => {
  const port = fresh();
  const a = await port.request(req);
  const waiting = port.wait(a.id);
  await port.close();
  assert.equal((await waiting).status, 'pending');
  await assert.rejects(port.get(a.id), /closed/);
  await assert.rejects(port.request(req), /closed/);
  await assert.rejects(port.wait(a.id), /closed/);
  await port.close();
});

test('a request for a key with a pending approval reuses it, across handles on one file, so lookup finds the decided one', async () => {
  const [a, b] = [createSqliteApproval({ path: file('shadow') }), createSqliteApproval({ path: file('shadow') })];
  const [r1, r2] = await Promise.all([a.request({ ...req, key: 'k' }), b.request({ ...req, key: 'k' })]);
  assert.equal(r2.id, r1.id);
  await a.decide(r1.id, { approved: true });
  assert.equal((await b.lookup('k', { consume: true }))?.status, 'approved');
  const expiring = await a.request({ ...req, key: 'old', expiresAt: new Date(Date.now() + 10).toISOString() });
  await sleep(20);
  assert.notEqual((await b.request({ ...req, key: 'old' })).id, expiring.id, 'an expired request is not reused');
  await Promise.all([a.close(), b.close()]);
});

test('the folder and file it creates are private (0700, 0600); an existing file keeps its mode', { skip: process.platform === 'win32' }, async () => {
  const path = join(dir, 'private', 'nested', 'approvals.db');
  const port = createSqliteApproval({ path });
  await port.request({ ...req, key: 'k' });
  await port.close();
  assert.equal((await stat(join(dir, 'private', 'nested'))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const mine = join(dir, 'mine.db');
  await writeFile(mine, '', { mode: 0o640 });
  await createSqliteApproval({ path: mine }).close();
  assert.equal((await stat(mine)).mode & 0o777, 0o640);
});

test('consumed and expired rows older than retainMs are pruned on open and on later requests', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 2) });
  const rows = (p: { native(): { prepare(sql: string): { get(): unknown } } }) => (p.native().prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n;
  const path = file('prune');
  const port = createSqliteApproval({ path, retainMs: 60_000 });
  const used = await port.request({ ...req, key: 'used' });
  await port.decide(used.id, { approved: true });
  await port.lookup('used', { consume: true });
  await port.request({ ...req, key: 'gone', expiresAt: new Date(Date.now() + 1000).toISOString() });
  await port.request({ ...req, key: 'kept' });
  const denied = await port.request({ ...req, key: 'no' });
  await port.decide(denied.id, { approved: false });
  assert.equal(rows(port), 4);
  t.mock.timers.tick(30_000);
  await port.request({ ...req, key: 'later' });
  assert.equal(rows(port), 5, 'nothing is past retainMs yet');
  t.mock.timers.tick(40_000);
  const reopened = createSqliteApproval({ path, retainMs: 60_000 });
  assert.equal(rows(reopened), 3, 'on open: the consumed and the expired rows are gone; pending and denied stay');
  assert.equal((await reopened.lookup('no'))?.status, 'denied');
  t.mock.timers.tick(120_000);
  await port.lookup('later', { consume: true });
  await port.decide((await port.lookup('later'))!.id, { approved: true });
  await port.lookup('later', { consume: true });
  t.mock.timers.tick(120_000);
  await port.request({ ...req, key: 'fresh' });
  assert.equal(rows(port), 3, 'on a request a minute later: the consumed row is gone');
  await Promise.all([port.close(), reopened.close()]);
});
