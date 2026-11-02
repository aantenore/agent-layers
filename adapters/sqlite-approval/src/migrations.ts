import type { DatabaseSync } from 'node:sqlite';

/**
 * Schema migrations, applied in order. Entry `i` brings the schema to version `i + 1`. Append new entries; never edit
 * one that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE approvals (
     id TEXT PRIMARY KEY,
     key TEXT,
     status TEXT NOT NULL,
     approval TEXT NOT NULL,
     expires_at INTEGER,
     consumed INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX approvals_by_key ON approvals (key) WHERE key IS NOT NULL;`,
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

/** Runs `fn` in a write transaction (taken up front, so concurrent writers wait on the busy timeout). */
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
