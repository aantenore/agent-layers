import type { DatabaseSync } from 'node:sqlite';

/**
 * Schema migrations, applied in order. Entry `i` brings the schema to version `i + 1`. Append new entries; never edit
 * one that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE entries (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     version INTEGER NOT NULL,
     expires_at INTEGER,
     updated_at INTEGER NOT NULL
   ) WITHOUT ROWID;
   CREATE INDEX entries_by_expiry ON entries (expires_at) WHERE expires_at IS NOT NULL;
   CREATE TABLE version_counter (id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL);
   INSERT INTO version_counter (id, last) VALUES (1, 0);`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Current schema version of an open database (0 for a new one). */
export function schemaVersion(db: DatabaseSync): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

/** Applies the missing migrations, each in its own transaction. Refuses a database written by a newer version. */
export function migrate(db: DatabaseSync): number {
  const current = schemaVersion(db);
  if (current > SCHEMA_VERSION) throw new Error(`database schema version ${current} is newer than this adapter supports (${SCHEMA_VERSION})`);
  for (let v = current; v < SCHEMA_VERSION; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v + 1, Date.now());
    });
  }
  return SCHEMA_VERSION;
}

/**
 * Runs `fn` in a write transaction taken up front (`BEGIN IMMEDIATE`): the read of the current version and the write
 * that depends on it cannot interleave with another process, and concurrent writers wait on the busy timeout.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
