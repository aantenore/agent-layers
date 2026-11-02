# @agent-layers/adapters/sqlite-store

Maps **SQLite** → **StorePort** (layer `harness`). Tiers: prototype, production (single node).

Keeps small JSON values by key in one SQLite file through `node:sqlite`, the SQLite driver built into Node, so the
package has no dependencies. Values survive restarts and can be shared by several processes on one host. Each `set`
and `delete` is one `BEGIN IMMEDIATE` transaction that reads the key's current version and writes the next, so
compare-and-set (`ifVersion`) holds across processes: of two writers with the same version, one wins and the other gets
a conflict with the current version. Versions come from one counter kept in the file, so a key written again after a
delete or an expiry gets a newer version than any it had. An expired key reads as absent from its expiry on.

- **Node**: `node:sqlite` is available without flags from Node 22.13 and 23.4; this repository requires 22.18, so no
  flag is needed. Node 22 prints an `ExperimentalWarning` the first time the module loads.
- **Durability**: WAL journal with `synchronous = NORMAL`; each write is one transaction.
- **Schema**: versioned migrations recorded in `schema_migrations`; opening a file written by a newer version of the
  adapter fails instead of guessing.
- **Scope**: one host. Several processes on that host may share the file (writers wait up to `busyTimeoutMs`). For
  several nodes, use a networked database behind another StorePort adapter. Values may hold user data and the file is
  not encrypted: put it on a protected volume and back it up like any database.
- **Permissions**: a folder the adapter creates is `0700` and a database file it creates is `0600` (SQLite gives the
  `-wal` and `-shm` files the same mode). An existing folder or file keeps its permissions: check them yourself.
- **Retention**: an expired key is deleted `retainMs` after its expiry: on open, and at most once a minute on `set`.
  Keys without expiry stay until deleted.

Keys are `<namespace>.<name>` ([StorePort](../../../../spec/ports/StorePort.md)); `list` returns keys with a prefix in key
order, at most `listLimit`, and pages with `after`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | `.agent-layers/store.db` | Database file, relative to the stack config folder; `:memory:` for tests |
| `busyTimeoutMs` | integer | `5000` | How long a write waits for a lock held by another process; `0` fails at once |
| `maxKeyChars` | integer | `512` | Longest key |
| `maxValueBytes` | integer | `65536` | Largest value, as JSON in UTF-8 |
| `listLimit` | integer | `100` | Most keys one `list` returns, and its default |
| `retainMs` | integer or `"unbounded"` | `3600000` (1 hour) | How long an expired key stays in the file; `"unbounded"` keeps it |

Limits accept `${env:NAME}`; `busyTimeoutMs` also accepts `"unbounded"` (SQLite's longest wait). On the production tier,
`agent-layers check` fails on an unbounded `busyTimeoutMs` and warns on an unbounded `retainMs` or a `maxValueBytes`
above 1 MiB. Ranges and checks: [docs/limits.md](../../../../docs/limits.md).

```json
{ "layers": { "store": { "adapter": "sqlite-store", "options": { "path": ".agent-layers/store.db" } } } }
```

`native()` returns the `DatabaseSync` handle.
