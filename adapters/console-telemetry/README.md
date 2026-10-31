# @agent-layers/adapter-console-telemetry

Maps **terminal output** → **TelemetryPort** (layer `telemetry`). Tier: prototype.

Prints finished spans, events and (optionally) metrics to the terminal, one line each, tagged with the layer they
belong to. It is meant for development and demos; use a file or collector adapter for anything that must be kept.
Pretty lines look like `[L4 knowledge] knowledge.search 12ms ok knowledge.source=docs knowledge.passages=3`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `format` | `pretty` \| `json` | `pretty` | Readable lines, or one JSON record per line |
| `stream` | `stdout` \| `stderr` | `stderr` | Where lines are written |
| `spans` | boolean | `true` | Print spans |
| `events` | boolean | `true` | Print events |
| `metrics` | boolean | `false` | Print metrics |
| `color` | boolean | stream is a terminal | ANSI colors in pretty output |

```json
{ "layers": { "telemetry": [{ "adapter": "console-telemetry", "options": { "format": "pretty", "metrics": true } }] } }
```
