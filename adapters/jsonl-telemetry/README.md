# @agent-layers/adapter-jsonl-telemetry

Maps **JSON Lines files** → **TelemetryPort** (layer `telemetry`). Tier: prototype, production.

Appends every finished span, event and metric to a file as one JSON record per line, so the output can be tailed,
shipped by a log collector or loaded into any analysis tool. Writes are synchronous: nothing is buffered, so there is
nothing to flush. A write failure is reported once on stderr and never breaks a run. Records carry the language's
`agent.*` names unchanged.

**Rotation.** When a record would take the file past `maxFileBytes`, the files are shifted (`<path>` → `<path>.1` →
... → `<path>.<maxFiles>`, the oldest deleted) and the record starts a fresh `<path>`. A single record larger than the
cap is still written, alone in a fresh file, so the cap can be exceeded by one record. The size is read when the adapter
starts (an existing file over the cap is rotated by the first write) and tracked in memory afterwards: let one process
own a file. `truncate` empties only the active file. If the files cannot be shifted, the failure is reported once and the
record is appended anyway. `maxFileBytes: "unbounded"` never rotates; `agent-layers check` warns about it on the
production tier.

**Trace ids.** With `traceIds` the records carry W3C ids, and the remote parent and the context `current()` returns use
`traceparent` (`parent`) and `tracestate` (`state`). Validation is strict: lowercase `00-<32 hex>-<16 hex>-<2 hex>` (a
later version may append `-` fields), version `ff` and all-zero ids refused; an invalid parent starts a new trace, and a
`tracestate` that is longer than 512 characters, has more than 32 members or is not `key=value` per the W3C grammar is
dropped. The codec (`src/w3c.ts`) is a copy of the one in `otlp`; the two adapters do not depend on each other.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | required | File to append to, relative to the config directory; parent directories are created |
| `truncate` | boolean | `false` | Empty the file when the adapter starts |
| `traceIds` | boolean | `true` | Write `traceId`, `spanId` and `parentSpanId` (W3C ids) on each record, join a caller's trace and give outbound calls the active context. Keep it on one recorder per stack |
| `maxFileBytes` | integer or `"unbounded"` | 104857600 | Size at which the file is rotated, at least 1024; a single larger record is still written, to a fresh file |
| `maxFiles` | integer | 5 | Rotated files kept (`<path>.1` is the newest), 1–100; older ones are deleted |

Limits accept `${env:NAME}`. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{ "layers": { "telemetry": [{ "adapter": "jsonl-telemetry", "options": { "path": "logs/telemetry.jsonl" } }] } }
```
