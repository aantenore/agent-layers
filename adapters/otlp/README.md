# @agent-layers/adapter-otlp

Maps **OpenTelemetry OTLP/HTTP + GenAI semantic conventions** → **TelemetryPort** (layer `telemetry`). Tiers: prototype,
production. Maturity: experimental.

Exports traces to `/v1/traces` and metrics to `/v1/metrics` as OTLP/HTTP JSON, with no SDK. Any collector accepts it,
and so do backends with a direct OTLP endpoint. Jaeger, Langfuse, Tempo, Grafana and Prometheus need no adapter of
their own: point this one at a collector (see `reference/telemetry`) or at their OTLP URL. Put a collector in front of
backends that take protobuf only.

**Nesting.** The span that is active when another starts becomes its parent (`AsyncLocalStorage`), so a run is one trace:
`invoke_agent` at the top, and `chat`, `execute_tool`, `guard.check`, `authorize`, `knowledge.search`, `cache.lookup`
and `router.select` below it. Concurrent runs keep separate traces; parallel work shares its parent.

**Every span has `agent.layer`.** Span names follow the GenAI conventions (`chat gpt-4o`, `invoke_agent support`,
`execute_tool crm__get`); `chat` spans are kind CLIENT. `error.type` is set on failed spans. Events attach to the active
span; one with no span around it is exported as a zero-length span (`orphanEvents`).

**Metrics** are cumulative. Everything the stack records is exported as it comes (`gen_ai.client.token.usage` as a
GenAI histogram, `agent.tool.calls`, `agent.policy.decisions`, `agent.guardrail.actions` as counters). Two are derived
from spans: `gen_ai.client.operation.duration` (seconds, from `chat` spans) and `agent.runs` (by `run.status`, from
`invoke_agent` spans).

**No content, no secrets.** Prompts, answers, tool arguments and results, queries, reasons and error text are left out
unless `captureContent` is true; secret-looking attribute keys are masked as the TelemetryPort requires. Span status
carries only `error.type` by default. Export failures never reach the run: the first one per signal is reported with
`process.emitWarning`: the origin and one of `HTTP <status>`, `timeout`, `invalid response`, `network error`, never error
text. An endpoint with credentials in the URL is rejected at creation; put them in `headers`. Spans of a failed batch are dropped; metrics are re-sent with the next export.

`current()` (and `native().traceparent()`) return the W3C context of the active span, which the stack's HTTP adapters send on outbound calls. A span started outside any other with a remote `parent` (the gateway passes the request's `traceparent`) joins that trace; flags and `tracestate` are kept.

Tested live against OpenTelemetry Collector 0.164 and Jaeger 2.22 (`reference/telemetry`): nested spans found through
`/api/v3/traces`, metrics on the collector's Prometheus endpoint (`:8889`).

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `endpoint` | string | `OTEL_EXPORTER_OTLP_ENDPOINT`, else `http://localhost:4318` | Collector base URL, or the full `/v1/traces` URL |
| `headers` | object | none | Extra request headers, e.g. backend authentication |
| `serviceName` | string | `OTEL_SERVICE_NAME`, else `agent-layers` | `service.name` of the resource |
| `resourceAttributes` | object | none | Extra resource attributes |
| `captureContent` | boolean | `false` | Export content attributes and error text |
| `metrics` | boolean | `true` | Export metrics |
| `intervalMs` | integer | 2000 | Export interval; the rest is sent on `flush` and `close` |
| `maxBatch` | integer | 512 | Export early when this many spans wait |
| `timeoutMs` | integer | 10000 | Per-request timeout |
| `semconvNames` | boolean | `true` | Name spans `<operation> <target>` |
| `orphanEvents` | `"span"` \| `"drop"` | `"span"` | What to do with an event outside any span |

```json
{
  "layers": {
    "telemetry": [
      { "adapter": "otlp", "options": { "endpoint": "${env:OTEL_EXPORTER_OTLP_ENDPOINT}", "serviceName": "support-agent" } }
    ]
  }
}
```
