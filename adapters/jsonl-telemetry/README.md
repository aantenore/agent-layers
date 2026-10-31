# @agent-layers/adapter-jsonl-telemetry

Maps **JSON Lines files** → **TelemetryPort** (layer `telemetry`). Tier: prototype, production.

Appends every finished span, event and metric to a file as one JSON record per line, so the output can be tailed,
shipped by a log collector or loaded into any analysis tool. Writes are synchronous: nothing is buffered, so there is
nothing to flush. A write failure is reported once on stderr and never breaks a run.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | required | File to append to, relative to the config directory; parent directories are created |
| `truncate` | boolean | `false` | Empty the file when the adapter starts |
| `traceIds` | boolean | `true` | Write `traceId`, `spanId` and `parentSpanId` (W3C ids) on each record, join a caller's trace and give outbound calls the active context. Keep it on one recorder per stack |

```json
{ "layers": { "telemetry": [{ "adapter": "jsonl-telemetry", "options": { "path": "logs/telemetry.jsonl" } }] } }
```
