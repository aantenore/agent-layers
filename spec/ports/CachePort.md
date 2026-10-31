# CachePort

Layer: `cache` (L2 Model access (routing, fallback, quotas, cache)) · Version: 1.0.0 · Conformance: `checkCache`

## Purpose

A small key/value store with optional expiry, so repeated work can be skipped. It is listed under the cache layer because the stack uses it for model replies, but any layer may use it: tool results, embeddings, retrieval results.

## Operations

- `get(key: String) → Any?`
  Return the stored value, or nothing when the key is missing or expired.
- `set(key: String, value: Any, opts?: {ttlMs?: Integer}) → ()`
  Store a JSON-serialisable value under the key, replacing any previous value. With `ttlMs` the value expires after that many milliseconds.
- `delete?(key: String) → ()`
  Optional. Remove the key. Removing a missing key is not an error.

## Data shapes

Keys are strings. Values are any JSON value; what goes in comes out equal. The model pipeline uses keys of the form `chat:<hash>`, where the hash covers the guarded [ModelRequest](../schemas/model-request.json) (without the stream flag), and stores the raw [ModelReply](../schemas/model-reply.json) (see [ModelPort](ModelPort.md)).

## Semantics

- Values round-trip: `get` after `set` returns a value equal to the stored one (same structure, including `null` and nested arrays/objects).
- A missing key and an expired key both give "nothing", never an error.
- Expiry is checked on read: after `ttlMs` has passed, `get` must not return the value.
- The cache is an optimisation. The stack treats a failing `get` as a miss and ignores a failing `set`, so a cache outage never fails a model call. Adapters should still reject on real failures rather than hide them.
- The cache stores model replies before output guards run; guards are applied again on hits, so cached content is never released unchecked.
- Other layers using the port choose their own key prefix to avoid collisions.

## Errors

- Resolves to nothing: missing or expired key.
- Rejects: store unreachable, value not serialisable.

## Escape hatch

The port has no shape of its own to extend. `ext` bags inside cached values (namespaced keys declared in the producing adapter's `ext.produces` / `ext.reads`) are stored and returned unchanged. `native()` returns the underlying store client, for operations the port does not cover (counters, scans, invalidation by pattern).

## Conformance

`checkCache` verifies:

- `get` of a missing key resolves to nothing.
- `set` then `get` returns an equal value for a nested JSON value.
- When `delete` exists: after `delete` the key is gone.
- Unless disabled: a value stored with a short `ttlMs` is gone after the TTL elapses.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): baseline; keys are computed over `ModelRequest`, values are `ModelReply`
- 0.1.0 — initial

Example adapters: `memory-cache` (in-process map).
