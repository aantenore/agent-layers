import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter, createSqliteState, SCHEMA_VERSION, storeSchemaVersion } from '../src/index.ts';

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'sqlite-state-')); });
after(() => rm(dir, { recursive: true, force: true }));

const fresh = (name: string) => createSqliteState({ path: join(dir, `${name}.db`) });

test('sqlite-state passes StatePort conformance', async () => {
  const report = await checkAdapter(adapter, { options: { path: 'conformance.db' }, ctx: { cwd: dir } });
  assert.deepEqual(report.failures, []);
  assert.ok(existsSync(join(dir, 'conformance.db')), 'relative path resolves against the config folder');
});

test('read returns appended events in order, across appends', async () => {
  const state = fresh('order');
  await state.append('s', [{ type: 'a', n: 1 }, { type: 'b' }]);
  await state.append('s', []);
  await state.append('s', [{ type: 'c', nested: { x: [1, 2] } }]);
  assert.deepEqual(await state.read('s'), [{ type: 'a', n: 1 }, { type: 'b' }, { type: 'c', nested: { x: [1, 2] } }]);
  assert.deepEqual(await state.read('other'), []);
  await state.close();
});

test('list returns the most recently appended sessions first, limited', async () => {
  const state = fresh('list');
  for (const id of ['one', 'two', 'three', 'one']) await state.append(id, [{ type: 'x' }]);
  assert.deepEqual(await state.list(), ['one', 'three', 'two']);
  assert.deepEqual(await state.list({ limit: 2 }), ['one', 'three']);
  assert.deepEqual(await state.list({ limit: 0 }), []);
  await state.close();
});

test('delete forgets a session and its events', async () => {
  const state = fresh('delete');
  await state.append('s', [{ type: 'a' }]);
  await state.append('t', [{ type: 'b' }]);
  await state.delete('s');
  assert.deepEqual(await state.read('s'), []);
  assert.deepEqual(await state.list(), ['t']);
  await state.close();
});

test('events survive close and reopen', async () => {
  const path = join(dir, 'durable.db');
  const first = createSqliteState({ path });
  await first.append('session-1', [{ type: 'run_start', runId: 'r1' }, { type: 'run_end', status: 'completed' }]);
  await first.append('session-2', [{ type: 'run_start', runId: 'r2' }]);
  await first.close();
  await assert.rejects(first.read('session-1'), /closed/);

  const second = createSqliteState({ path });
  assert.deepEqual(await second.read('session-1'), [{ type: 'run_start', runId: 'r1' }, { type: 'run_end', status: 'completed' }]);
  assert.deepEqual(await second.list(), ['session-2', 'session-1']);
  await second.append('session-1', [{ type: 'run_start', runId: 'r3' }]);
  assert.equal((await second.read('session-1')).length, 3);
  assert.deepEqual(await second.list(), ['session-1', 'session-2']);
  await second.close();
});

test('a file database uses WAL and records its schema version', async () => {
  const state = fresh('wal');
  const db = state.native();
  assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  assert.equal(storeSchemaVersion(state), SCHEMA_VERSION);
  await state.close();
  const reopened = fresh('wal');
  const rows = reopened.native().prepare('SELECT version FROM schema_migrations').all();
  assert.equal(rows.length, SCHEMA_VERSION, 'migrations are not applied twice');
  await reopened.close();
});

test('a database from a newer schema is refused', async () => {
  const path = join(dir, 'newer.db');
  const state = createSqliteState({ path });
  state.native().prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION + 1, Date.now());
  await state.close();
  assert.throws(() => createSqliteState({ path }), /newer than this adapter supports/);
});

test(':memory: works without a file', async () => {
  const state = createSqliteState({ path: ':memory:' });
  await state.append('s', [{ type: 'a' }]);
  assert.deepEqual(await state.read('s'), [{ type: 'a' }]);
  await state.close();
});
