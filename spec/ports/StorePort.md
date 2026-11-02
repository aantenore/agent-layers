# StorePort

Layer: `harness` (L3 Agent runtime) · Version: 1.0.0 · Conformance: `checkStore`

## Purpose

Keep small JSON values by key, durably, with a version per key so concurrent writers can update a value safely
(compare-and-set). A host keeps the state of its agents here: progress of a task, a cursor, a counter, the settings of a
session.

It sits beside [StatePort](StatePort.md) in the harness layer, the layer that answers "how does the agent loop run
and keep state". StatePort is an append-only log of what happened; StorePort is the current value of named things,
read and replaced. It is not [CachePort](CachePort.md): a cache may lose an entry at any time, a store must not.

## Operations

- `get(key: String) → StoreEntry?`
  Return the value and its version, or nothing for an absent or expired key.
- `set(key: String, value: Json, opts?: {ifVersion?: Integer, ttlMs?: Integer}) → {ok: true, version: Integer} | {ok: false, version?: Integer}`
  Write the value and return its new version. With `ifVersion`, write only when the key's current version is that one
  (`0`: only when the key is absent); otherwise return `ok: false` with the current version (absent when there is no
  key) and change nothing. With `ttlMs`, the key expires that many milliseconds after the write.
- `delete(key: String, opts?: {ifVersion?: Integer}) → {ok: true, existed: Boolean} | {ok: false, version?: Integer}`
  Remove the key. `existed` tells whether it was there. `ifVersion` works as for `set`.
- `list(prefix: String, opts?: {limit?: Integer, after?: String}) → [StoreKey]` (optional)
  Return the keys that start with `prefix`, in key order, with their versions: those after `after` when given, at most
  `limit`. The adapter caps `limit` and uses its cap when `limit` is absent; page with `after` set to the last key.

## Data shapes

[StoreEntry](../schemas/store-entry.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `value` | Json, required | The value as written. |
| `version` | Integer ≥ 1, required | Version of this write. |
| `expiresAt?` | String | ISO 8601 time after which the key reads as absent. |

`StoreKey`: `key: String`, `version: Integer`, `expiresAt?: String`.

Keys are `<namespace>.<name>`: the namespace in lower case (`[a-z][a-z0-9-]*`, at most 64 characters), the name
printable ASCII without spaces. The namespace is the component that owns the key, so components sharing a store cannot
collide; `sdk` is the core's. Adapters bound the key length and the value size with declared limits (the adapters in
this repository: 512 characters, 65536 bytes of JSON).

## Semantics

- Values are JSON: `null`, booleans, finite numbers, strings, arrays and plain objects. The store keeps a copy: changing
  the value after `set`, or the value `get` returned, never changes what is stored.
- Versions are positive integers. Every successful `set` gives the key a version greater than any it had before, also
  after a delete or an expiry, so a version is never reused for a key and a stale `ifVersion` can never match by
  chance. An adapter may draw versions from one counter for the whole store.
- An absent or expired key has version `0` for `ifVersion`.
- Compare-and-set is atomic: of several writes with the same `ifVersion`, at most one succeeds, also across the
  processes sharing a durable store.
- An expired key reads as absent everywhere (`get`, `list`, `ifVersion`) from its `expiresAt` on. When the adapter
  deletes the expired data is up to it; it declares that retention.
- `list` sees only live keys. Keys and values are opaque to the store.
- A conflict is a result, not an error: the caller reads the current value and decides.
- Values may hold user data. Keep the store as private as the runs that write it.

## Errors

- Returned as a result: a conflict (`ok: false`).
- Rejects: a malformed key, a key or value over the adapter's limits, a value that is not JSON, an `ifVersion` that is
  not an integer ≥ 0, a `ttlMs` that is not an integer > 0, a full store, store unreachable.
- Resolves normally: `get` of an absent key (nothing), `delete` of an absent key (`existed: false`).

## Escape hatch

`native()` returns the underlying store (the `DatabaseSync` handle for `sqlite-store`, the `Map` for
`memory-store`).

## Conformance

`checkStore` verifies, under a fresh key prefix:

- `get` of an unknown key resolves to nothing; a written value reads back equal, as a [StoreEntry](../schemas/store-entry.json), and is a copy both ways.
- Every `set` increases the version; `ifVersion` with a stale version is a conflict naming the current version and changes nothing; with the current version it succeeds; `ifVersion: 0` creates only an absent key; of two concurrent writes with the same `ifVersion` exactly one succeeds.
- `delete` with a stale `ifVersion` is a conflict and keeps the key; with the current one it removes it; deleting an absent key succeeds with `existed: false`; a key written again after a delete gets a newer version than before.
- A key written with `ttlMs` has `expiresAt` and reads as absent after it, also for `ifVersion: 0`.
- Malformed keys, non-JSON values (`undefined`, `NaN`, functions, a `Date`), `ifVersion: -1` and `ttlMs: 0` reject; a value of exactly the size limit is accepted and one byte more rejects (fixture `maxValueBytes`, default 65536).
- Isolation: a key in another namespace, or a longer key with the same start, is another key.
- When `list` is implemented: keys in key order, only those with the prefix, with versions; `limit` and `after` are respected.

## Version history

- 1.0.0 — initial: get, set and delete with compare-and-set on versions, expiry, optional list

Example adapters: `memory-store` (in-process map), `sqlite-store` (one SQLite file through `node:sqlite`).
