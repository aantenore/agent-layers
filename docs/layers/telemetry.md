# L9 Telemetry & observability (`telemetry`)

## Responsibility

See what agents do: traces for every run, metrics for cost, tokens, tool calls, policy and guardrail activity. It is
also the input of [eval](eval.md).

## Standard

OpenTelemetry OTLP with the GenAI semantic conventions.

## Extension point

`Sink.onEvent`: receives every run event. The OTLP sink is one implementation.

## Reference implementation

| Role | Reference | License |
|---|---|---|
| Pipeline | OpenTelemetry Collector | Apache-2.0 |
| LLM observability UI | Langfuse | MIT core; `ee/` excluded |
| Trace UI | Jaeger | Apache-2.0 |

Phoenix (Elastic License 2.0) is deliberately not used.

## Adapter SDK + conformance

Not needed: OTLP is the standard, and a backend is swapped in the collector. A custom `Sink` is only for destinations
OTLP cannot reach.

## Around the layer

- **`agent.layer` on every span**, so any trace can be filtered or attributed by layer.
- **Metrics:** tokens, cost, tool calls, policy decisions, guardrail actions.
- **Audit.** Denials and guard actions are visible here; see [governance](../cross-cutting/governance-compliance.md).

## How to swap it

The runtime exports OTLP/HTTP to one endpoint. Change the collector's exporters to send to Tempo, Grafana, Datadog
or any OTLP backend. No agent change is needed.

## Contract

- OTLP/HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Spans: `invoke_agent`, `chat`, `execute_tool`, each with the attribute `agent.layer` (`infra`, `llm`, `harness`,
  `knowledge`, `tool`, `identity`, `guardrail`, `cache`, `telemetry`, `eval`, `interface`; the last is L10 and the
  reinloop binding will add it).
- Metrics: `gen_ai.client.token.usage`, `gen_ai.client.operation.duration`, `agent.tool.calls`, `agent.cost.usd`,
  `agent.policy.decisions`, `agent.guardrail.actions`.
- The collector fans out to Langfuse and Jaeger.
- No tokens or secrets in attributes.

Details in the port spec: [TelemetryPort](../../spec/ports/TelemetryPort.md).

## How to test

```bash
make up LAYER=l8-telemetry
make test LAYER=l8-telemetry
make down LAYER=l8-telemetry
```

The test runs an agent, then looks up its trace in Jaeger and Langfuse and checks the span names and `agent.layer`.
Variables: `OTEL_EXPORTER_OTLP_ENDPOINT`, `LANGFUSE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `JAEGER_UI`.
