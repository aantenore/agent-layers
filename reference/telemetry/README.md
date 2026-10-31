# L8 Telemetry and observability

Standard: [OpenTelemetry](https://opentelemetry.io) (OTLP/HTTP, GenAI semantic conventions).
Documentation: [docs/L8-telemetry.md](../../docs/L8-telemetry.md). Contract: [docs/contracts.md](../../docs/contracts.md#l8-telemetry).

## Extension point

A `Sink` (`onEvent(event)`) in the runtime turns the `RunEvent` stream into OTLP. Every span carries `agent.layer`
(`harness`, `llm`, the tool's layer or `tool`); events of other layers (`guardrail`, `knowledge_retrieval`,
`tool_decision`, ...) are span events mapped by an event-type-to-layer table. Metrics are cumulative OTLP.
Anything that speaks OTLP/HTTP can sit on either side.

## References

| Component | Role | Image | License |
|---|---|---|---|
| OpenTelemetry Collector (contrib) | OTLP in; fans traces out, exposes metrics | `otel/opentelemetry-collector-contrib:0.164.0` | Apache-2.0 |
| Jaeger v2 | Trace store and UI (in-memory) | `jaegertracing/jaeger:2.22.0` | Apache-2.0 |
| Langfuse v3 | LLM observability UI (OTLP ingest at `/api/public/otel`) | `langfuse/langfuse:3.225.15`, `langfuse/langfuse-worker:3.225.15` | MIT (core) |
| ClickHouse, PostgreSQL, Redis | Langfuse stores | `clickhouse/clickhouse-server:26.3.62`, `postgres:17.11-alpine`, `redis:7.4.12-alpine` | Apache-2.0, PostgreSQL, BSD-3 |
| MinIO | Langfuse S3 event storage | `bitnamilegacy/minio:2025.7.23-debian-12-r5` | AGPL-3.0 (separate process, not linked) |

The MinIO image is a frozen build (upstream stopped publishing images). Any S3-compatible store works: change the
`LANGFUSE_S3_*` variables in `compose.yml`.

## Run

```bash
make up LAYER=l8-telemetry      # first start pulls ~6 GB and takes a few minutes
make down LAYER=l8-telemetry    # add -v on the compose command to drop volumes
```

| Port | Service |
|---|---|
| 4318 / 4317 | Collector OTLP/HTTP / gRPC (`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`) |
| 8889 | Collector Prometheus exporter (`/metrics`) |
| 16686 | Jaeger UI (`JAEGER_UI`) |
| 3000 | Langfuse (`LANGFUSE_URL`) |

Langfuse is created headless with organization `agent-layers`, project `local`, the keys
`LANGFUSE_PUBLIC_KEY=pk-lf-local` / `LANGFUSE_SECRET_KEY=sk-lf-local`, and the user `admin@example.com` /
`change-me-local`. Its postgres, redis, clickhouse and minio publish no host port. Replace every default before
exposing anything beyond localhost.

## Use it from reinloop

```json
"sinks": [{ "type": "otlp", "endpoint": "http://localhost:4318", "metrics": true, "serviceName": "my-agent" }]
```

Message content, tool arguments and results are exported only with `"captureContent": true`. Tokens never are.

## Swap

- Backends: edit `otel-collector.yaml` (exporters and the `traces` pipeline), for example Tempo, Grafana Cloud,
  Honeycomb or Datadog instead of Jaeger or Langfuse. The runtime keeps sending OTLP to the same endpoint.
- Collector: point `OTEL_EXPORTER_OTLP_ENDPOINT` at any OTLP/HTTP receiver. Langfuse also takes OTLP/HTTP directly at
  `${LANGFUSE_URL}/api/public/otel` (Basic auth with the key pair; it does not take gRPC).
- Runtime: any runtime that emits spans and metrics with the same attributes works; the event-to-layer mapping is data.

## Test

```bash
make test LAYER=l8-telemetry
REINLOOP_SRC=/path/to/reinloop/src/index.ts make test LAYER=l8-telemetry
```

The test runs a reinloop agent (mock model, one tool call) with the `otlp` sink and checks that the trace is found in
Jaeger (query API v3) with `agent.layer` and `enduser.id`, that Langfuse lists it (polled, ingestion is delayed), and that
the collector Prometheus endpoint exposes `agent_tool_calls`, `agent_runs` and the GenAI histograms. It skips with a
message if a service is unreachable.

Notes: the collector and Jaeger images have no shell, so they carry no container healthcheck. Jaeger v2 no longer serves
the v1 `/api/traces` endpoint.
