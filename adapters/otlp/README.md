# @agent-layers/adapter-otlp

Maps **OpenTelemetry OTLP/HTTP + GenAI semantic conventions** → **TelemetryPort** (layer `telemetry`). Tiers: prototype,
production. Maturity: experimental.

Exports traces to `/v1/traces` and metrics to `/v1/metrics` as OTLP/HTTP JSON, with no SDK. Any collector accepts it,
and so do backends with a direct OTLP endpoint. Jaeger, Langfuse, Tempo, Grafana and Prometheus need no adapter of
their own: point this one at a collector (see `reference/telemetry`) or at their OTLP URL. Put a collector in front of
backends that take protobuf only.

**Nesting.** The span that is active when another starts becomes its parent (`AsyncLocalStorage`), so a run is one trace:
`invoke_agent` at the top, and `chat`, `execute_tool`, `agent.guard.check`, `agent.access.check`,
`agent.knowledge.search`, `agent.cache.lookup` and `agent.router.select` below it. Concurrent runs keep separate traces;
parallel work shares its parent.

**Every span has `agent.layer`.** `error.type` is set on failed spans. Events attach to the active span; one with no
span around it is exported as a zero-length span (`orphanEvents`).

## GenAI mapping

The stack speaks `agent.*`; this adapter is the only one that writes the OpenTelemetry GenAI names, so dashboards built
on `gen_ai.*` keep working. The table lives in one module, [`src/semconv.ts`](src/semconv.ts), as data.

| Language | Exported as |
|---|---|
| span `agent.run` | `invoke_agent <agent>`, `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name` (from `agent.name`) |
| span `agent.model.call` | `chat <model>`, kind CLIENT, `gen_ai.operation.name=chat`, `gen_ai.request.model` (`agent.model.requested`), `gen_ai.response.model` (`agent.model.used`) |
| span `agent.tool.call` | `execute_tool <tool>`, `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name` (`agent.tool.name`) |
| `agent.tokens.input`, `agent.tokens.output` | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` |
| `agent.model.finish` | `gen_ai.response.finish_reasons` (list of one): `end` → `stop`, `limit` → `length`, `tools` → `tool_calls`, `refused` → `content_filter`; `other` and unknown values pass through |
| metric `agent.model.tokens` + `agent.tokens.kind` | `gen_ai.client.token.usage` + `gen_ai.token.type` (plus `gen_ai.operation.name=chat`) |
| duration of `agent.model.call` | metric `gen_ai.client.operation.duration` (seconds), derived |
| span `agent.run` | metric `agent.runs` (by `agent.run.status`), derived |
| everything else (`agent.guard.*`, `agent.access.*`, `agent.tool.calls`, spans such as `agent.guard.check`) | unchanged: no semantic convention exists |

The original `agent.*` attributes are **kept** next to the `gen_ai.*` ones, so queries on the language names work too and
no value is lost (`other` finish reasons keep their language value); the cost is one extra attribute per mapped value.
`semconvNames: false` keeps the `agent.*` span names (`agent.run`) while the attributes and metrics are still mapped.
`agent.error` and the texts of `*.reason` count as content (see below); `agent.run.reason`, the stop code, does not.

**Metrics** are cumulative. Everything the stack records is exported as it comes (`gen_ai.client.token.usage` as a
GenAI histogram, `agent.tool.calls`, `agent.access.decisions`, `agent.guard.actions` as counters). Two are derived from
spans: `gen_ai.client.operation.duration` and `agent.runs`.

**No content, no secrets.** Prompts, answers, tool arguments and results, queries, reasons and error text are left out
unless `captureContent` is true; secret-looking attribute keys are masked as the TelemetryPort requires. Span status
carries only `error.type` by default. Export failures never reach the run: the first one per signal is reported with
`process.emitWarning`: the origin and one of `HTTP <status>`, `redirects are not followed (HTTP <status>)`, `timeout`,
`invalid response`, `network error`, never error text. Redirects are never followed, so spans and `headers` stay with
the configured collector. An endpoint with credentials in the URL is rejected at creation; put them in `headers`. Spans of a failed batch are dropped; metrics are re-sent with the next export.

**Trace context.** The core treats `TraceContext {parent, state}` as opaque; this adapter owns the W3C Trace Context
format (`src/w3c.ts`). `current()` (and `native().traceparent()`) return the context of the active span as `traceparent`
(`parent`) and `tracestate` (`state`), which the stack's HTTP adapters send on outbound calls. A span started outside any
other with a remote `parent` joins that trace; flags and `tracestate` are kept. Validation is strict: `traceparent` must
match `00-<32 hex>-<16 hex>-<2 hex>` in lowercase (a later version may append `-` fields), version `ff` and all-zero ids
are refused, and an invalid parent starts a new trace without failing the run. A `tracestate` is dropped (the trace still
joins) when it is longer than 512 characters, has more than 32 members, repeats a key or has a member that is not
`key=value` per the W3C grammar.

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
| `maxQueue` | integer | `maxBatch * 8` | Spans kept while the collector is slow or down; the oldest are dropped beyond it (at least `maxBatch`) |
| `timeoutMs` | integer | 10000 | Per-request timeout |
| `errorMessageChars` | integer | 200 | Characters of an error message exported with `captureContent` |
| `semconvNames` | boolean | `true` | Name spans `<operation> <target>` (`invoke_agent support`); `false` keeps `agent.run`, `agent.model.call`, `agent.tool.call` |
| `orphanEvents` | `"span"` \| `"drop"` | `"span"` | What to do with an event outside any span |

Limits accept `${env:NAME}`; `maxQueue` and `timeoutMs` also accept `"unbounded"`, which `agent-layers check` fails on the
production tier. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{
  "layers": {
    "telemetry": [
      { "adapter": "otlp", "options": { "endpoint": "${env:OTEL_EXPORTER_OTLP_ENDPOINT}", "serviceName": "support-agent" } }
    ]
  }
}
```
