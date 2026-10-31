# @agent-layers/adapter-memory-cache

Maps **in-process Map** → **CachePort** (layer `cache`). Tier: prototype.

Keeps cached values in a Map inside the process, with least-recently-used eviction and optional expiry. Values are
copied with `structuredClone` on the way in and out, so callers cannot mutate cached data. The cache is lost on
restart: use it for development and demos.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `maxEntries` | integer | `1000` | Entries kept before the least recently used one is evicted |
| `ttlMs` | integer | no expiry | Default time to live in milliseconds; a per-call `ttlMs` overrides it |

Limits accept `${env:NAME}`; `maxEntries` and `ttlMs` also accept `"unbounded"`, which `agent-layers check` fails on (`maxEntries`)
or warns about (`ttlMs`) on the production tier. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{ "layers": { "cache": { "adapter": "memory-cache", "options": { "maxEntries": 500, "ttlMs": 60000 } } } }
```
