# @agent-layers/adapter-sqlite-approval

Maps **SQLite** → **ApprovalPort** (layer `identity`). Tiers: prototype, production (single node).

Keeps approvals in one SQLite file through `node:sqlite`, the SQLite driver built into Node, so the package has no
dependencies. A pending approval can be answered later, from another process, and survives restarts. `wait` resolves
the moment `decide` is called in the same process; to see a decision taken by another process sharing the file, it
re-reads the database every `pollMs`. Deciding an approval that is no longer pending is an error. `lookup` returns the
latest approval requested with a key that has not been consumed; consuming an approved one is a single transaction,
so two callers, in one process or several, never both receive it. A `request` with a key that already has a pending,
unexpired approval returns that one (checked and written in one `BEGIN IMMEDIATE` transaction), so concurrent calls
never leave a second approval that hides the one a person decides. A pending approval past its expiry reads as
`expired`, derived on read. The stored request keeps the `AccessQuestion` as asked, except that its caller never
carries a credential.

- **Node**: `node:sqlite` is available without flags from Node 22.13 and 23.4; this repository requires 22.18, so no
  flag is needed. Node 22 prints an `ExperimentalWarning` the first time the module loads.
- **Durability**: WAL journal with `synchronous = NORMAL`; each `request`, `decide` and consuming `lookup` is one
  transaction.
- **Schema**: versioned migrations recorded in `schema_migrations`; opening a file written by a newer version of
  the adapter fails instead of guessing.
- **Scope**: one host. Several processes on that host may share the file (writers wait up to `busyTimeoutMs`). For
  several nodes, use a networked database behind another ApprovalPort adapter. Approvals contain the tool
  arguments and the file is not encrypted: put it on a protected volume and back it up like any database.
- **Permissions**: a folder the adapter creates is `0700` and a database file it creates is `0600` (SQLite gives the
  `-wal` and `-shm` files the same mode). An existing folder or file keeps its permissions: check them yourself.
- **Retention**: consumed approvals, and pending ones past their expiry, are deleted `retainMs` after they were
  created (consumed) or expired (pending): on open, and at most once a minute on `request`. Denied and approved but
  unconsumed approvals stay, since `lookup` answers with them.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | `.agent-layers/approvals.db` | Database file, relative to the stack config folder; `:memory:` for tests |
| `busyTimeoutMs` | integer | `5000` | How long a write waits for a lock held by another process; `0` fails at once |
| `ttlMs` | integer or `"unbounded"` | `"unbounded"` | Time a pending approval stays open; afterwards it reports `expired` and `expiresAt` is set on the request |
| `pollMs` | integer | `500` | Interval at which `wait` re-reads the database to see a decision taken by another process |
| `retainMs` | integer or `"unbounded"` | `604800000` (7 days) | How long consumed and expired rows are kept; `"unbounded"` keeps every row |

Limits accept `${env:NAME}`; `busyTimeoutMs` and `ttlMs` also accept `"unbounded"` (for `busyTimeoutMs`, SQLite's
longest wait). On the production tier, `agent-layers check` fails on an unbounded `busyTimeoutMs` and warns on an
unbounded `ttlMs` or `retainMs`. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{ "layers": { "approval": { "adapter": "sqlite-approval", "options": { "path": ".agent-layers/approvals.db", "ttlMs": 600000 } } } }
```

`native()` returns the `DatabaseSync` handle.
