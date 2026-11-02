# @agent-layers/adapters/memory-store

Maps **in-process Map** → **StorePort** (layer `harness`). Tier: prototype.

Keeps small JSON values by key in memory, with a version per key for compare-and-set and an optional expiry per write.
Values are stored as JSON text, so a read never shares an object with the store or with the writer. Versions come from
one counter for the whole store: a key written again after a delete or an expiry gets a newer version than any it had.
Expired keys read as absent at once and are dropped when touched or when the store is full. Everything is lost on
restart: use it for development and tests; use [`sqlite-store`](../sqlite-store) for durable state.

Memory is bounded: past `maxKeys`, a write of a new key is refused (after dropping expired keys), never by evicting a
live value, since a store must not lose state silently. Writes of existing keys still succeed.

Keys are `<namespace>.<name>` ([StorePort](../../../../spec/ports/StorePort.md)); `list` returns keys with a prefix in key
order, at most `listLimit`, and pages with `after`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `maxKeys` | integer or `"unbounded"` | `10000` | Keys kept; a new key beyond this is refused once expired keys are dropped |
| `maxKeyChars` | integer | `512` | Longest key |
| `maxValueBytes` | integer | `65536` | Largest value, as JSON in UTF-8 |
| `listLimit` | integer | `100` | Most keys one `list` returns, and its default |

Limits accept `${env:NAME}`; `agent-layers check` warns on an unbounded `maxKeys` on the production tier, where this
adapter cannot be used anyway (prototype only). Ranges and checks: [docs/limits.md](../../../../docs/limits.md).

```json
{ "layers": { "store": { "adapter": "memory-store" } } }
```

`native()` returns the `Map` of entries.
