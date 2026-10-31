# Contracts

The contracts between layers live in [`spec/`](../spec/README.md), which is the source of truth and is language
neutral:

| What | Where |
|---|---|
| Data shapes (JSON Schema, draft 2020-12) | [`spec/schemas/`](../spec/schemas) |
| Ports: operations, semantics, errors, conformance | [`spec/ports/`](../spec/ports/README.md) |
| Versioning rules (semver per port) | [`spec/VERSIONING.md`](../spec/VERSIONING.md) |
| Stack configuration schema | [`spec/schemas/stack-config.json`](../spec/schemas/stack-config.json) |

`packages/core` is the TypeScript binding of the spec. Another language binds the same schemas and port pages.

## Host ports and environment

All values are defaults for local development and live in [`.env.example`](../.env.example).

| Layer | Variable | Default |
|---|---|---|
| llm | `LLM_BASE_URL` | `http://localhost:11434/v1` |
| llm | `LLM_MODEL` | `qwen3:4b` |
| llm | `LLM_API_KEY` | `ollama` |
| harness | `REINLOOP_SERVE_PORT` | `8700` |
| knowledge | `QDRANT_URL` | `http://localhost:6333` |
| knowledge | `QDRANT_COLLECTION` | `docs` |
| knowledge | `WIKI_DIR` | `layers/l3-knowledge/wiki` |
| tool | `HTTPBIN_URL` | `http://localhost:8085` |
| tool | `OPENAPI_MCP_URL` | `http://localhost:8090/mcp` |
| identity | `OIDC_ISSUER` | `http://localhost:8080/realms/agents` |
| identity | `OIDC_CLIENT_ID` | `agent-runtime` |
| identity | `OIDC_CLIENT_SECRET` | `change-me` |
| identity | `TOOLS_AUDIENCE` | `tools-api` |
| identity | `OPA_URL` | `http://localhost:8181` |
| guardrail | `PRESIDIO_ANALYZER_URL` | `http://localhost:5002` |
| guardrail | `PRESIDIO_ANONYMIZER_URL` | `http://localhost:5001` |
| guardrail | `LLM_GUARD_URL` | `http://localhost:8000` |
| guardrail | `LLM_GUARD_TOKEN` | `change-me` |
| cache | `GATEWAY_URL` | `http://localhost:4000/v1` |
| cache | `GATEWAY_KEY` | `sk-local-change-me` |
| cache | `VALKEY_URL` | `redis://localhost:6379` |
| telemetry | `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` |
| telemetry | `LANGFUSE_URL` | `http://localhost:3000` |
| telemetry | `LANGFUSE_PUBLIC_KEY` | `pk-lf-local` |
| telemetry | `LANGFUSE_SECRET_KEY` | `sk-lf-local` |
| telemetry | `JAEGER_UI` | `http://localhost:16686` |
| eval | `EVAL_DATASET` | `layers/l9-eval/datasets/smoke.jsonl` |

Ollama runs natively on the host. Containers reach it at `host.docker.internal:11434`.

These defaults belong to the reference setups (`reference/<layer>/`, today still under `layers/`). A stack config
reads them through `${env:NAME:-default}`.
