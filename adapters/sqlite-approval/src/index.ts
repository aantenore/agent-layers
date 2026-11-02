import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AdapterError, defineAdapter, errorMessage, limitProperties, limitValue, PORT_VERSIONS, type Approval, type ApprovalPort, type ApprovalRequest, type LimitValue } from '@agent-layers/core';
import { LIMITS, PRUNE_EVERY_MS, SQLITE_MAX_WAIT_MS } from './limits.ts';
import { migrate, SCHEMA_VERSION, transaction } from './migrations.ts';

export { MIGRATIONS, SCHEMA_VERSION } from './migrations.ts';
export { LIMITS } from './limits.ts';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface SqliteApprovalOptions {
  /** Database file, relative to the stack config folder (default `.agent-layers/approvals.db`); `:memory:` for tests. */
  path?: string;
  /** How long a write waits for another process holding the database lock (default 5000 ms; 0 fails at once). */
  busyTimeoutMs?: LimitValue;
  /** Time a pending approval stays open before it reports `expired`. Open indefinitely when unset or `"unbounded"`. */
  ttlMs?: LimitValue;
  /** Interval at which `wait` re-reads the database, to see a decision taken by another process (default 500 ms). */
  pollMs?: LimitValue;
  /**
   * How long consumed approvals, and pending ones past their expiry, are kept before they are deleted (default 7 days;
   * `"unbounded"` keeps every row). Pruned on open and, at most once a minute, on `request`.
   */
  retainMs?: LimitValue;
}

export const DEFAULT_PATH = '.agent-layers/approvals.db';

const ADAPTER = 'sqlite-approval';

/** An ApprovalPort whose `native()` is the open `DatabaseSync` handle. */
export interface SqliteApproval extends ApprovalPort {
  native(): DatabaseSync;
  lookup: NonNullable<ApprovalPort['lookup']>;
  close(): Promise<void>;
}

type Sqlite = typeof import('node:sqlite');

interface Row { approval: string; expires_at: number | null }

/** A `wait` in progress: `check` re-reads its approval, `release` ends it with the last state seen. */
interface Waiter { id: string; check(): void; release(): void }

const fail = (message: string, options?: ErrorOptions) => new AdapterError('identity', ADAPTER, message, options);

/** `node:sqlite` is built into Node (unflagged since 22.13); loaded on first use so importing the package costs nothing. */
function sqlite(): Sqlite {
  const mod = process.getBuiltinModule?.('node:sqlite') as Sqlite | undefined;
  if (!mod?.DatabaseSync) throw fail(`node:sqlite is not available in Node ${process.version} (needs >= 22.13)`);
  return mod;
}

/** A copy of the request whose caller never carries a credential, even when one slips in: approvals are shown to people. */
function stored(req: ApprovalRequest): ApprovalRequest {
  const request = structuredClone(req);
  const caller = request.question?.caller as { credential?: unknown } | undefined;
  if (caller && typeof caller === 'object') delete caller.credential;
  return request;
}

/** The approval a row holds; a pending one past its expiry reads as `expired`. */
function view(row: Row): Approval {
  const approval = JSON.parse(row.approval) as Approval;
  return approval.status === 'pending' && row.expires_at !== null && row.expires_at <= Date.now() ? { ...approval, status: 'expired' } : approval;
}

/**
 * Creates the folder (0700) and the database file (0600) when they do not exist yet: approvals hold tool arguments.
 * Existing ones keep their permissions.
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

/**
 * Approvals in one SQLite file: WAL journal, a versioned schema, one row per approval. `wait` is woken at once by a
 * `decide` in this process and polls for one taken by another. Single node: several processes on one host may share
 * the file; a cluster needs a networked database.
 */
export function createSqliteApproval(options: SqliteApprovalOptions = {}, ctx: { cwd?: string } = {}, name = ADAPTER): SqliteApproval {
  const file = options.path === ':memory:' ? ':memory:' : resolve(ctx.cwd ?? process.cwd(), options.path ?? DEFAULT_PATH);
  const ttlMs = limitValue(LIMITS.ttlMs, options.ttlMs);
  const pollMs = limitValue(LIMITS.pollMs, options.pollMs);
  const retainMs = limitValue(LIMITS.retainMs, options.retainMs);
  const waiters = new Set<Waiter>();
  let prunedAt = 0;
  /** Deletes consumed approvals created, and pending ones expired, more than `retainMs` ago. */
  const prune = (d: DatabaseSync) => {
    if (!Number.isFinite(retainMs)) return;
    const now = Date.now();
    const before = now - retainMs;
    d.prepare("DELETE FROM approvals WHERE (consumed = 1 AND created_at <= ?) OR (status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?)").run(before, before);
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
    if (!db) throw fail('the approval store is closed');
    return db;
  };
  const read = (d: DatabaseSync, id: string): Approval | undefined => {
    const row = d.prepare('SELECT approval, expires_at FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row && view(row);
  };
  const unknown = (id: string) => fail(`unknown approval ${id}`);

  return {
    name,
    native: () => open(),
    async request(req) {
      const d = open();
      const parsed = req.expiresAt ? Date.parse(req.expiresAt) : Number.isFinite(ttlMs) ? Date.now() + ttlMs : NaN;
      const expiresAt = Number.isFinite(parsed) ? parsed : null;
      const request = stored(req);
      if (expiresAt !== null && !request.expiresAt) request.expiresAt = new Date(expiresAt).toISOString();
      const approval: Approval = { id: randomUUID(), status: 'pending', request };
      return transaction(d, () => {
        if (Date.now() - prunedAt >= PRUNE_EVERY_MS) prune(d);
        // A pending, unexpired request for the same key is the one a person will decide: reuse it, so `lookup` finds it.
        if (request.key) {
          const pending = d.prepare("SELECT approval, expires_at FROM approvals WHERE key = ? AND consumed = 0 AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?) ORDER BY rowid DESC LIMIT 1")
            .get(request.key, Date.now()) as Row | undefined;
          if (pending) return view(pending);
        }
        d.prepare('INSERT INTO approvals (id, key, status, approval, expires_at, consumed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
          .run(approval.id, request.key ?? null, approval.status, JSON.stringify(approval), expiresAt, Date.now());
        return read(d, approval.id)!;
      });
    },
    async lookup(key, opts = {}) {
      const d = open();
      const latest = () => d.prepare('SELECT id, approval, expires_at FROM approvals WHERE key = ? AND consumed = 0 ORDER BY rowid DESC LIMIT 1').get(key) as (Row & { id: string }) | undefined;
      if (!opts.consume) {
        const row = latest();
        return row && view(row);
      }
      return transaction(d, () => {
        const row = latest();
        if (!row) return undefined;
        const current = view(row);
        if (current.status === 'approved') d.prepare('UPDATE approvals SET consumed = 1 WHERE id = ? AND consumed = 0').run(row.id);
        return current;
      });
    },
    async get(id) {
      return read(open(), id);
    },
    async decide(id, decision) {
      const d = open();
      const decided = transaction(d, () => {
        const current = read(d, id);
        if (!current) throw unknown(id);
        if (current.status !== 'pending') throw fail(`approval ${id} is already ${current.status}`);
        const next: Approval = {
          ...current,
          status: decision.approved ? 'approved' : 'denied',
          ...(decision.by !== undefined ? { decidedBy: decision.by } : {}),
          ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        };
        d.prepare('UPDATE approvals SET status = ?, approval = ? WHERE id = ?').run(next.status, JSON.stringify(next), id);
        return next;
      });
      for (const waiter of [...waiters]) if (waiter.id === id) waiter.check();
      return decided;
    },
    wait(id, opts = {}) {
      return new Promise<Approval>((resolve, reject) => {
        let last = read(open(), id);
        if (!last) return reject(unknown(id));
        if (last.status !== 'pending') return resolve(last);
        if (opts.signal?.aborted) return reject(opts.signal.reason);

        const timers: NodeJS.Timeout[] = [];
        const finish = () => {
          timers.forEach(clearTimeout);
          waiters.delete(waiter);
          opts.signal?.removeEventListener('abort', abort);
        };
        const settle = () => {
          finish();
          try { resolve(read(open(), id) ?? last!); } catch (err) { reject(err); }
        };
        const check = () => {
          try {
            last = read(open(), id) ?? last;
            if (last!.status !== 'pending') settle();
          } catch (err) { finish(); reject(err); }
        };
        const abort = () => { finish(); reject(opts.signal?.reason); };
        const waiter: Waiter = { id, check, release: () => { finish(); resolve(last!); } };

        waiters.add(waiter);
        opts.signal?.addEventListener('abort', abort, { once: true });
        timers.push(setInterval(check, pollMs));
        if (opts.timeoutMs !== undefined) timers.push(setTimeout(settle, opts.timeoutMs));
      });
    },
    async close() {
      for (const waiter of [...waiters]) waiter.release();
      const d = db;
      db = undefined;
      d?.close();
    },
  };
}

export const adapter = defineAdapter<'ApprovalPort', SqliteApprovalOptions>({
  layer: 'identity',
  port: 'ApprovalPort',
  name: ADAPTER,
  direction: 'outbound',
  maps: { technology: 'SQLite' },
  portVersion: PORT_VERSIONS.ApprovalPort,
  tiers: ['prototype', 'production'],
  description: `Durable approvals in one SQLite file (node:sqlite, WAL, schema v${SCHEMA_VERSION}). Production on a single node; several processes on one host may share the file.`,
  optionsSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1 },
      ...limitProperties(LIMITS, {
        ttlMs: 'Time a pending approval stays open before it expires',
        busyTimeoutMs: 'How long a write waits for another process holding the database lock',
        pollMs: 'Interval at which a wait re-reads the database to see a decision taken by another process',
        retainMs: 'How long consumed approvals and expired pending ones are kept before they are deleted',
      }),
    },
    additionalProperties: false,
  },
  limits: LIMITS,
  ext: { produces: [] },
  create: (options, ctx) => createSqliteApproval(options, ctx, ctx.name),
});

export const adapters = [adapter];
