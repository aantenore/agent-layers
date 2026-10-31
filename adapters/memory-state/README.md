# @agent-layers/adapter-memory-state

Maps **in-process Map** → **StatePort** (layer `harness`). Tier: prototype.

Keeps each session's append-only event log in memory. Events are copied on the way in and out, `read` returns them in
append order and `list` returns the most recently appended sessions first. Everything is lost on restart: use it for
development and demos.

Memory is bounded. When a new session would exceed `maxSessions`, the least recently appended session is evicted.
When an append would exceed `maxEventsPerSession`, the oldest events of that session are dropped: the log is a
window over the most recent events, so resuming a session sees recent history, not its start.

Events are stored as `RunEvent` values, unchanged. Nothing is persisted, so there are no old logs to convert.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `maxSessions` | integer | `1000` | Sessions kept; a new session beyond this evicts the least recently appended one |
| `maxEventsPerSession` | integer | `10000` | Events kept per session; older events are dropped, the most recent are kept |

Limits accept `${env:NAME}` and `"unbounded"`, which `agent-layers check` warns about on the production tier, as it
does for values above `100000` sessions or `1000000` events. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{ "layers": { "state": { "adapter": "memory-state" } } }
```
