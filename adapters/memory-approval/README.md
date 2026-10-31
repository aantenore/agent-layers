# @agent-layers/adapter-memory-approval

Maps **in-process store** → **ApprovalPort** (layer `identity`). Tier: prototype.

Keeps approvals in memory. `wait` resolves the moment an approval is decided, without polling, and returns the pending
approval when its timeout elapses. Deciding an approval that is no longer pending is an error. Everything is lost on
restart: use it for development and demos. The stored request keeps the `AccessQuestion` as asked, except that its
caller never carries a credential. `lookup` returns the latest approval requested with a key that has not been
consumed; consuming an approved one lets exactly one call through.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `ttlMs` | integer or `"unbounded"` | `"unbounded"` | Time a pending approval stays open; afterwards it reports `expired` and `expiresAt` is set on the request |

`ttlMs` accepts `${env:NAME}`. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{ "layers": { "approval": { "adapter": "memory-approval", "options": { "ttlMs": 600000 } } } }
```
