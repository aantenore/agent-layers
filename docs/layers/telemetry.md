# Telemetry & observability

Layer id `telemetry` (L9), Insight plane. *What happened?*

## Responsibility

See what agents do: traces for every run, metrics for cost, tokens, tool calls, policy and guardrail activity. It is
also the input of [eval](eval.md).

## Ports

| Port | What it does |
|---|---|
| [TelemetryPort](../../spec/ports/TelemetryPort.md) | `span`, `event` and `metric` calls, each tagged with `agent.layer`; several adapters can run at once |

## Standards

OpenTelemetry OTLP with the GenAI semantic conventions.

## Boundaries

- **`agent.layer` on every span, event and metric**, so any trace can be filtered or attributed by layer. The values are
  the layer ids.
- Typical spans: `invoke_agent`, `chat`, `execute_tool`. Typical metrics: `gen_ai.client.token.usage`,
  `gen_ai.client.operation.duration`, `agent.tool.calls`, `agent.cost.usd`, `agent.policy.decisions`,
  `agent.guardrail.actions`.
- No tokens or secrets in attributes; the stack masks keys that look like secrets before adapters see them.
- **Audit.** Denials and guard actions are visible here; see [governance](../cross-cutting/governance-compliance.md).

## How to swap

An OTLP adapter exports to one endpoint. Change the collector's exporters to send to Tempo, Grafana, Datadog or any
OTLP backend; no agent change is needed. A custom adapter is only for destinations OTLP cannot reach.

## Reference adapters

| Adapter | Maps |
|---|---|
| `console-telemetry` | Terminal output, one line per span |
| `jsonl-telemetry` | JSON Lines files |
| `otlp` | OTLP with the GenAI semantic conventions |

Full list: [adapters.md](../adapters.md).

## Reference setup

[`reference/telemetry/`](../../reference/telemetry/README.md) runs the OpenTelemetry Collector (Apache-2.0) fanning
out to Jaeger (Apache-2.0) and Langfuse (MIT core; the `ee/` directories are under a separate commercial license and
are not used). Phoenix (Elastic License 2.0) is deliberately not used. Variables: `OTEL_EXPORTER_OTLP_ENDPOINT`,
`LANGFUSE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `JAEGER_UI`.

```bash
make up LAYER=telemetry
make test LAYER=telemetry
make down LAYER=telemetry
```

The test runs an agent, then looks up its trace in Jaeger and Langfuse and checks the span names and `agent.layer`.
