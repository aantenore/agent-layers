import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { AdapterRegistry, limitFindings, limitList, noopTelemetry } from '@agent-layers/core';
import { adapter, createSqliteStore, LIMITS, SCHEMA_VERSION, storeSchemaVersion, type SqliteStore } from '../../src/sqlite-store/index.ts';

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'sqlite-store-')); });
after(() => rm(dir, { recursive: true, force: true }));

const file = (name: string) => join(dir, `${name}.db`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ctx = { name: 'store', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
const make = (options: Record<string, unknown>) => new AdapterRegistry().register(adapter).create('StorePort', 'sqlite-store', { path: ':memory:', ...options }, ctx) as Promise<SqliteStore>;
const rows = (s: SqliteStore) => (s.native().prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;

test('values and versions survive reopening the file; the file keeps its schema version', async () => {
  const first = createSqliteStore({ path: file('reopen') });
  const written = await first.set('app.k', { a: [1, 2] });
  await first.close();
  const second = createSqliteStore({ path: file('reopen') });
  const read = await second.get('app.k');
  assert.ok(written.ok);
  assert.deepEqual(read, { value: { a: [1, 2] }, version: written.version });
  const next = await second.set('app.other', 1);
  assert.ok(next.ok && next.version > written.version, 'the version counter is in the file');
  assert.equal(storeSchemaVersion(second), SCHEMA_VERSION);
  await second.close();
});

test('compare-and-set holds across handles sharing one file', async () => {
  const [a, b] = [createSqliteStore({ path: file('shared') }), createSqliteStore({ path: file('shared') })];
  const base = await a.set('app.counter', 0);
  assert.ok(base.ok);
  const results = await Promise.all([a.set('app.counter', 1, { ifVersion: base.version }), b.set('app.counter', 2, { ifVersion: base.version })]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  const lost = results.find((r) => !r.ok)!;
  assert.equal(lost.version, (await b.get('app.counter'))?.version);
  await Promise.all([a.close(), b.close()]);
});

test('expired keys read as absent at once and are pruned retainMs after expiry', async () => {
  const store = createSqliteStore({ path: ':memory:', retainMs: 0 });
  await store.set('app.t', 1, { ttlMs: 5 });
  await sleep(20);
  assert.equal(await store.get('app.t'), undefined);
  assert.equal(rows(store), 1, 'kept until the next prune');
  await store.close();
  const kept = createSqliteStore({ path: file('retain'), retainMs: 'unbounded' });
  await kept.set('app.t', 1, { ttlMs: 5 });
  await sleep(20);
  await kept.close();
  const reopened = createSqliteStore({ path: file('retain'), retainMs: 'unbounded' });
  assert.equal(rows(reopened), 1, 'unbounded keeps expired rows');
  await reopened.close();
  const pruned = createSqliteStore({ path: file('retain'), retainMs: 0 });
  assert.equal(rows(pruned), 0, 'pruned on open');
  await pruned.close();
});

test('the folder and file it creates are private (0700, 0600); an existing file keeps its mode', { skip: process.platform === 'win32' }, async () => {
  const path = join(dir, 'private', 'nested', 'store.db');
  await createSqliteStore({ path }).close();
  assert.equal((await stat(join(dir, 'private', 'nested'))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const mine = join(dir, 'mine.db');
  await writeFile(mine, '', { mode: 0o640 });
  await createSqliteStore({ path: mine }).close();
  assert.equal((await stat(mine)).mode & 0o777, 0o640);
});

test('a closed store refuses operations', async () => {
  const store = createSqliteStore({ path: ':memory:' });
  await store.close();
  await assert.rejects(store.get('app.k'), /closed/);
});

test('limits: busyTimeoutMs sets the lock wait; invalid values are rejected; production findings', async () => {
  const busy = (s: SqliteStore) => (s.native().prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
  const ports = [await make({}), await make({ busyTimeoutMs: '1500' }), await make({ busyTimeoutMs: 'unbounded' })];
  assert.deepEqual(ports.map(busy), [5000, 1500, 2 ** 31 - 1]);
  await Promise.all(ports.map((p) => p.close()));
  for (const bad of [{ busyTimeoutMs: -1 }, { maxValueBytes: 10 }, { maxKeyChars: 1 }, { listLimit: 0 }, { retainMs: -1 }]) {
    await assert.rejects(make(bad), new RegExp(Object.keys(bad)[0]!), JSON.stringify(bad));
  }
  const specs = limitList(LIMITS);
  assert.deepEqual(limitFindings(specs, { options: {} }, 'production'), []);
  const findings = limitFindings(specs, { options: { busyTimeoutMs: 'unbounded', retainMs: 'unbounded' } }, 'production');
  assert.deepEqual(findings.map((f) => [f.path, f.severity]), [['options.busyTimeoutMs', 'fail'], ['options.retainMs', 'warn']]);
});
