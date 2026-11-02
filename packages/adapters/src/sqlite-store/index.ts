import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  AdapterError, defineAdapter, encodeStoreValue, errorMessage, limitProperties, limitValue, PORT_VERSIONS, storeKeyProblem, storeOptionsProblem,
  type JsonValue, type LimitValue, type StoreKey, type StorePort,
} from '@agent-layers/core';
import { LIMITS, PRUNE_EVERY_MS, SQLITE_MAX_WAIT_MS } from './limits.ts';
import { migrate, schemaVersion, SCHEMA_VERSION, transaction } from './migrations.ts';

export { MIGRATIONS, SCHEMA_VERSION } from './migrations.ts';
export { LIMITS } from './limits.ts';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface SqliteStoreOptions {
  /** Database file, relative to the stack config folder (default `.agent-layers/store.db`); `:memory:` for tests. */
  path?: string;
  /** How long a write waits for another process holding the database lock (default 5000 ms; 0 fails at once). */
  busyTimeoutMs?: LimitValue;
  /** Longest key (default 512 characters). */
  maxKeyChars?: number;
  /** Largest value, as JSON in UTF-8 (default 65536 bytes). */
  maxValueBytes?: number;
  /** Most keys one `list` returns, and its default (default 100). */
  listLimit?: number;
  /**
   * How long an expired key stays in the file before it is deleted (default 1 hour; `"unbounded"` keeps it). It reads
   * as absent from its expiry on. Pruned on open and, at most once a minute, on `set`.
   */
  retainMs?: LimitValue;
}

export const DEFAULT_PATH = '.agent-layers/store.db';

const ADAPTER = 'sqlite-store';

/** A StorePort whose `native()` is the open `DatabaseSync` handle. */
export interface SqliteStore extends StorePort {
  native(): DatabaseSync;
  list: NonNullable<StorePort['list']>;
  close(): Promise<void>;
}

type Sqlite = typeof import('node:sqlite');

interface Row { key: string; value: string; version: number; expires_at: number | null }

const fail = (message: string, options?: ErrorOptions) => new AdapterError('harness', ADAPTER, message, options);

/** `node:sqlite` is built into Node (unflagged since 22.13); loaded on first use so importing the package costs nothing. */
function sqlite(): Sqlite {
  const mod = process.getBuiltinModule?.('node:sqlite') as Sqlite | undefined;
  if (!mod?.DatabaseSync) throw fail(`node:sqlite is not available in Node ${process.version} (needs >= 22.13)`);
  return mod;
}

/**
 * Creates the folder (0700) and the database file (0600) when they do not exist yet: stored values may hold user
 * data. Existing ones keep their permissions.
 */
function createPrivate(file: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file)) return;
  try {
    closeSync(openSync(file, 'wx', 0o600));
  } catch (err) {
    if ((err as { code?: string }).code !== 'EEXIST') throw err;
  }
}

const expiryOf = (row: Pick<Row, 'expires_at'>) => (row.expires_at !== null ? { expiresAt: new Date(row.expires_at).toISOString() } : {});

/**
 * Small JSON values in one SQLite file: WAL journal, a versioned schema, one row per key. Every write runs in one
 * `BEGIN IMMEDIATE` transaction that reads the current version and writes the next, so compare-and-set holds across
 * processes sharing the file. Versions come from one counter in the file, so a key never gets a version it had before.
 * Single node: several processes on one host may share the file; a cluster needs a networked database.
 */
export function createSqliteStore(options: SqliteStoreOptions = {}, ctx: { cwd?: string } = {}, name = ADAPTER): SqliteStore {
  const file = options.path === ':memory:' ? ':memory:' : resolve(ctx.cwd ?? process.cwd(), options.path ?? DEFAULT_PATH);
  const maxKeyChars = limitValue(LIMITS.maxKeyChars, options.maxKeyChars);
  const maxValueBytes = limitValue(LIMITS.maxValueBytes, options.maxValueBytes);
  const listLimit = limitValue(LIMITS.listLimit, options.listLimit);
  const retainMs = limitValue(LIMITS.retainMs, options.retainMs);
  let prunedAt = 0;
  /** Deletes keys expired more than `retainMs` ago. */
  const prune = (d: DatabaseSync) => {
    if (!Number.isFinite(retainMs)) return;
    const now = Date.now();
    d.prepare('DELETE FROM entries WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now - retainMs);
    prunedAt = now;
  };
  let db: DatabaseSync | undefined;
  try {
    if (file !== ':memory:') createPrivate(file);
    db = new (sqlite().DatabaseSync)(file);
    db.exec(`PRAGMA busy_timeout = ${Math.min(Math.trunc(limitValue(LIMITS.busyTimeoutMs, options.busyTimeoutMs)), SQLITE_MAX_WAIT_MS)}`);
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    migrate(db);
    const opened = db;
    transaction(opened, () => prune(opened));
  } catch (err) {
    db?.close();
    throw err instanceof AdapterError ? err : fail(`cannot open ${file}: ${errorMessage(err)}`, { cause: err });
  }

  const open = (): DatabaseSync => {
    if (!db) throw fail('the store is closed');
    return db;
  };
  const checkKey = (key: string) => {
    const problem = storeKeyProblem(key, maxKeyChars);
    if (problem) throw fail(problem);
  };
  /** The live row of a key: an expired one reads as absent. */
  const current = (d: DatabaseSync, key: string): Row | undefined =>
    d.prepare('SELECT key, value, version, expires_at FROM entries WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)').get(key, Date.now()) as Row | undefined;
  const conflict = (row: Row | undefined) => ({ ok: false as const, ...(row ? { version: row.version } : {}) });

  return {
    name,
    native: () => open(),
    async get(key) {
      checkKey(key);
      const row = current(open(), key);
      return row && { value: JSON.parse(row.value) as JsonValue, version: row.version, ...expiryOf(row) };
    },
    async set(key, value, opts = {}) {
      checkKey(key);
      const problem = storeOptionsProblem(opts);
      if (problem) throw fail(problem);
      const encoded = encodeStoreValue(value, maxValueBytes);
      if ('problem' in encoded) throw fail(encoded.problem);
      const d = open();
      return transaction(d, () => {
        if (Date.now() - prunedAt >= PRUNE_EVERY_MS) prune(d);
        const row = current(d, key);
        if (opts.ifVersion !== undefined && (row?.version ?? 0) !== opts.ifVersion) return conflict(row);
        const version = (d.prepare('UPDATE version_counter SET last = last + 1 WHERE id = 1 RETURNING last').get() as { last: number }).last;
        const now = Date.now();
        d.prepare('INSERT INTO entries (key, value, version, expires_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = excluded.version, expires_at = excluded.expires_at, updated_at = excluded.updated_at')
          .run(key, encoded.json, version, opts.ttlMs !== undefined ? now + opts.ttlMs : null, now);
        return { ok: true as const, version };
      });
    },
    async delete(key, opts = {}) {
      checkKey(key);
      const problem = storeOptionsProblem({ ...(opts.ifVersion !== undefined ? { ifVersion: opts.ifVersion } : {}) });
      if (problem) throw fail(problem);
      const d = open();
      return transaction(d, () => {
        const row = current(d, key);
        if (opts.ifVersion !== undefined && (row?.version ?? 0) !== opts.ifVersion) return conflict(row);
        // An expired row goes too: it already reads as absent.
        d.prepare('DELETE FROM entries WHERE key = ?').run(key);
        return { ok: true as const, existed: !!row };
      });
    },
    async list(prefix, opts = {}) {
      const limit = Math.min(listLimit, Math.max(0, Math.trunc(opts.limit ?? listLimit)));
      // Keys are printable ASCII (below 0x7f), so [prefix, prefix + 0x7f) is exactly the keys starting with prefix.
      const rows = open().prepare('SELECT key, version, expires_at FROM entries WHERE key >= ? AND key < ? AND key > ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?')
        .all(prefix, `${prefix}\x7f`, opts.after ?? '', Date.now(), limit) as unknown as Row[];
      return rows.map((r): StoreKey => ({ key: r.key, version: r.version, ...expiryOf(r) }));
    },
    async close() {
      const d = db;
      db = undefined;
      d?.close();
    },
  };
}

/** Schema version of the database file behind a store (for diagnostics and tests). */
export function storeSchemaVersion(store: SqliteStore): number {
  return schemaVersion(store.native());
}

export const adapter = defineAdapter<'StorePort', SqliteStoreOptions>({
  layer: 'harness',
  port: 'StorePort',
  name: ADAPTER,
  direction: 'outbound',
  maps: { technology: 'SQLite' },
  portVersion: PORT_VERSIONS.StorePort,
  tiers: ['prototype', 'production'],
  description: `Durable small JSON values by key in one SQLite file (node:sqlite, WAL, schema v${SCHEMA_VERSION}), with compare-and-set across processes. Production on a single node.`,
  optionsSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1 },
      ...limitProperties(LIMITS, {
        busyTimeoutMs: 'How long a write waits for another process holding the database lock',
        maxKeyChars: 'Longest key',
        maxValueBytes: 'Largest value, as JSON in UTF-8',
        listLimit: 'Most keys one list returns, and its default',
        retainMs: 'How long an expired key stays in the file before it is deleted',
      }),
    },
    additionalProperties: false,
  },
  limits: LIMITS,
  create: (options, ctx) => createSqliteStore(options, ctx, ctx.name),
});

export const adapters = [adapter];
