# @agent-layers/adapter-memory-approval

Maps **in-process store** → **ApprovalPort** (layer `identity`). Tier: prototype.

Keeps approvals in memory. `wait` resolves the moment an approval is decided, without polling, and returns the pending
approval when its timeout elapses. Deciding an approval that is no longer pending is an error. Everything is lost on
restart: use it for development and demos.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `ttlMs` | integer | none | Time a pending approval stays open; afterwards it reports `expired` and `expiresAt` is set on the request |

```json
{ "layers": { "approval": { "adapter": "memory-approval", "options": { "ttlMs": 600000 } } } }
```
