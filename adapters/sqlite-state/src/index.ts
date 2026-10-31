import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AdapterError, defineAdapter, errorMessage, PORT_VERSIONS, type RunEvent, type StatePort } from '@agent-layers/core';
import { migrate, schemaVersion, SCHEMA_VERSION, transaction } from './migrations.ts';

export { MIGRATIONS, SCHEMA_VERSION } from './migrations.ts';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface SqliteStateOptions {
  /** Database file, relative to the stack config folder (default `.agent-layers/state.db`); `:memory:` for tests. */
  path?: string;
  /** How long a write waits for another process holding the database lock (default 5000 ms). */
  busyTimeoutMs?: number;
}

export const DEFAULT_PATH = '.agent-layers/state.db';

/** A StatePort whose `native()` is the open `DatabaseSync` handle. */
export interface SqliteState extends StatePort {
  native(): DatabaseSync;
  close(): Promise<void>;
}

type Sqlite = typeof import('node:sqlite');

/** `node:sqlite` is built into Node (unflagged since 22.13); loaded on first use so importing the package costs nothing. */
function sqlite(): Sqlite {
  const mod = process.getBuiltinModule?.('node:sqlite') as Sqlite | undefined;
  if (!mod?.DatabaseSync) throw new AdapterError('harness', 'sqlite-state', `node:sqlite is not available in Node ${process.version} (needs >= 22.13)`);
  return mod;
}

/**
 * Session event logs in one SQLite file: WAL journal, a versioned schema, one row per event. Single node: several
 * processes on one host may share the file; a cluster needs a networked database.
 */
export function createSqliteState(options: SqliteStateOptions = {}, ctx: { cwd?: string } = {}, name = 'sqlite-state'): SqliteState {
  const file = options.path === ':memory:' ? ':memory:' : resolve(ctx.cwd ?? process.cwd(), options.path ?? DEFAULT_PATH);
  let db: DatabaseSync | undefined;
  try {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    db = new (sqlite().DatabaseSync)(file);
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5000))}`);
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    migrate(db);
  } catch (err) {
    db?.close();
    throw err instanceof AdapterError ? err : new AdapterError('harness', 'sqlite-state', `cannot open ${file}: ${errorMessage(err)}`, { cause: err });
  }

  const open = (): DatabaseSync => {
    if (!db) throw new AdapterError('harness', 'sqlite-state', 'the state store is closed');
    return db;
  };

  return {
    name,
    native: () => open(),
    async append(sessionId, events) {
      if (!events.length) return;
      const d = open();
      const rows = events.map((e) => JSON.stringify(e));
      transaction(d, () => {
        const now = Date.now();
        const touched = (d.prepare('SELECT COALESCE(MAX(touched), 0) + 1 AS t FROM sessions').get() as { t: number }).t;
        d.prepare('INSERT INTO sessions (id, touched, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET touched = excluded.touched, updated_at = excluded.updated_at')
          .run(sessionId, touched, now, now);
        const next = (d.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE session_id = ?').get(sessionId) as { s: number }).s;
        const insert = d.prepare('INSERT INTO events (session_id, seq, event) VALUES (?, ?, ?)');
        rows.forEach((row, i) => insert.run(sessionId, next + i + 1, row));
      });
    },
    async read(sessionId) {
      const rows = open().prepare('SELECT event FROM events WHERE session_id = ? ORDER BY seq').all(sessionId) as { event: string }[];
      return rows.map((r) => JSON.parse(r.event) as RunEvent);
    },
    async list(opts) {
      const limit = opts?.limit === undefined ? -1 : Math.max(0, Math.trunc(opts.limit));
      const rows = open().prepare('SELECT id FROM sessions ORDER BY touched DESC LIMIT ?').all(limit) as { id: string }[];
      return rows.map((r) => r.id);
    },
    async delete(sessionId) {
      const d = open();
      transaction(d, () => {
        d.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
        d.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      });
    },
    async close() {
      const d = db;
      db = undefined;
      d?.close();
    },
  };
}

/** Schema version of the database file behind a store (for diagnostics and tests). */
export function storeSchemaVersion(state: SqliteState): number {
  return schemaVersion(state.native());
}

export const adapter = defineAdapter<'StatePort', SqliteStateOptions>({
  layer: 'harness',
  port: 'StatePort',
  name: 'sqlite-state',
  direction: 'outbound',
  maps: { technology: 'SQLite' },
  portVersion: PORT_VERSIONS.StatePort,
  tiers: ['prototype', 'production'],
  description: `Durable session event logs in one SQLite file (node:sqlite, WAL, schema v${SCHEMA_VERSION}). Production on a single node.`,
  optionsSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1 },
      busyTimeoutMs: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  create: (options, ctx) => createSqliteState(options, ctx, ctx.name),
});

export const adapters = [adapter];
