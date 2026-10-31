# @agent-layers/adapter-sqlite-state

Maps **SQLite** → **StatePort** (layer `harness`). Tiers: prototype, production (single node).

Keeps each session's append-only event log in one SQLite file through `node:sqlite`, the SQLite driver built into
Node, so the package has no dependencies. `read` returns events in append order, `list` returns the most recently
appended sessions first, `delete` removes a session and its events. Events survive restarts.

- **Node**: `node:sqlite` is available without flags from Node 22.13 and 23.4; this repository requires 22.18, so no
  flag is needed. Node 22 prints an `ExperimentalWarning` the first time the module loads.
- **Durability**: WAL journal with `synchronous = NORMAL`; each `append` and `delete` is one transaction.
- **Schema**: versioned migrations recorded in `schema_migrations`; opening a file written by a newer version of
  the adapter fails instead of guessing.
- **Scope**: one host. Several processes on that host may share the file (writers wait up to `busyTimeoutMs`). For
  several nodes, use a networked database behind another StatePort adapter. The file is not encrypted: put it on a
  protected volume and back it up like any database.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | `.agent-layers/state.db` | Database file, relative to the stack config folder; `:memory:` for tests |
| `busyTimeoutMs` | integer | `5000` | How long a write waits for a lock held by another process |

```json
{ "layers": { "state": { "adapter": "sqlite-state", "options": { "path": ".agent-layers/state.db" } } } }
```

`native()` returns the `DatabaseSync` handle.
