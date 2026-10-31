# @agent-layers/adapter-memory-state

Maps **in-process Map** → **StatePort** (layer `harness`). Tier: prototype.

Keeps each session's append-only event log in memory. Events are copied on the way in and out, `read` returns them in
append order and `list` returns the most recently appended sessions first. Everything is lost on restart: use it for
development and demos.

## Options

None.

```json
{ "layers": { "state": { "adapter": "memory-state" } } }
```
