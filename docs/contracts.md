# Contracts

The contracts between layers live in [`spec/`](../spec/README.md), which is the source of truth and is language
neutral:

| What | Where |
|---|---|
| The SDK language: naming rules, shapes, vocabularies, `ext`, mappings (version 1.0) | [`spec/language.md`](../spec/language.md), decided in [ADR 0001](decisions/0001-sdk-language.md) |
| Data shapes (JSON Schema, draft 2020-12) | [`spec/schemas/`](../spec/schemas) |
| Ports: operations, semantics, errors, conformance | [`spec/ports/`](../spec/ports/README.md) |
| Versioning rules (semver per port) | [`spec/VERSIONING.md`](../spec/VERSIONING.md) |
| Stack configuration schema (adds `vocabularies`, `mappings`, `pipeline.knowledge.fusion`, `limits.extBytes`) | [`spec/schemas/stack-config.json`](../spec/schemas/stack-config.json) |

`packages/core` is the TypeScript binding of the spec. Another language binds the same schemas and port pages.

## Host ports and environment

All values are defaults for local development and live in [`.env.example`](../.env.example), which this table mirrors
(`npm run docs:check` compares them). Ports are bound to `127.0.0.1`.

| Layer | Variable | Default |
|---|---|---|
| llm | `LLM_BASE_URL` | `http://localhost:11434/v1` |
| llm | `LLM_MODEL` | `qwen3:4b` |
| llm | `LLM_API_KEY` | `ollama` |
| harness | `REINLOOP_SERVE_PORT` | `8700` |
| knowledge | `QDRANT_URL` | `http://localhost:6333` |
| knowledge | `QDRANT_COLLECTION` | `docs` |
| knowledge | `WIKI_DIR` | `reference/knowledge/wiki` |
| tool | `HTTPBIN_URL` | `http://localhost:8085` |
| tool | `HTTPBIN_PORT` | `8085` |
| tool | `OPENAPI_MCP_URL` | `http://localhost:8090/mcp` |
| tool | `OPENAPI_MCP_PORT` | `8090` |
| identity | `OIDC_ISSUER` | `http://localhost:8080/realms/agents` |
| identity | `OIDC_CLIENT_ID` | `agent-runtime` |
| identity | `OIDC_CLIENT_SECRET` | `change-me` |
| identity | `TOOLS_AUDIENCE` | `tools-api` |
| identity | `OPA_URL` | `http://localhost:8181` |
| identity | `KEYCLOAK_PORT` | `8080` |
| guardrail | `PRESIDIO_ANALYZER_URL` | `http://localhost:5002` |
| guardrail | `PRESIDIO_ANONYMIZER_URL` | `http://localhost:5001` |
| guardrail | `LLM_GUARD_URL` | `http://localhost:8000` |
| guardrail | `LLM_GUARD_TOKEN` | `change-me` |
| cache | `GATEWAY_URL` | `http://localhost:4000/v1` |
| cache | `GATEWAY_KEY` | `sk-local-change-me` |
| cache | `VALKEY_URL` | `redis://localhost:6379` |
| cache | `HOSTED_MODEL` | |
| cache | `HOSTED_API_KEY` | |
| cache | `HOSTED_HEADER_NAME` | `x-agent-layers-unused` |
| cache | `HOSTED_HEADER_VALUE` | |
| telemetry | `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` |
| telemetry | `LANGFUSE_URL` | `http://localhost:3000` |
| telemetry | `LANGFUSE_PUBLIC_KEY` | `pk-lf-local` |
| telemetry | `LANGFUSE_SECRET_KEY` | `sk-lf-local` |
| telemetry | `JAEGER_UI` | `http://localhost:16686` |
| eval | `EVAL_DATASET` | `reference/eval/datasets/smoke.jsonl` |

Ollama runs natively on the host. Containers reach it at `host.docker.internal:11434`.

Keycloak listens on `KEYCLOAK_PORT` (8080 by default). When 8080 is busy, start with `KEYCLOAK_PORT=18080` and set
`OIDC_ISSUER=http://localhost:18080/realms/agents`. The OpenAPI MCP bridge listens on `OPENAPI_MCP_PORT` (8090 by
default); if you change it, change `OPENAPI_MCP_URL` too.

### Compose overrides

Optional variables read by the reference compose files, with the defaults they use when unset. They are not in
`.env.example`.

| Layer | Variable | Default |
|---|---|---|
| infra | `INFRA_HTTP_PORT` | `8088` |
| infra | `INFRA_DASHBOARD_PORT` | `8089` |
| infra | `OPENBAO_PORT` | `8200` |
| infra | `OPENBAO_DEV_ROOT_TOKEN` | `dev-root-token` |
| llm | `OLLAMA_PORT` | `11434` |
| cache | `HOSTED_MAX_BUDGET_USD` | `1.0` |
| cache | `HOSTED_BUDGET_DURATION` | `30d` |
| cache | `LITELLM_NUM_RETRIES` | `0` |
| cache | `CACHE_TTL_S` | `600` |
| identity | `KEYCLOAK_ADMIN_PASSWORD` | `change-me` |
| guardrail | `PRESIDIO_ANALYZER_MEM_LIMIT` | `2g` |
| guardrail | `PRESIDIO_ANONYMIZER_MEM_LIMIT` | `512m` |
| guardrail | `LLM_GUARD_MEM_LIMIT` | `3g` |

These defaults belong to the reference setups (`reference/<layer id>/`). A stack config reads them through
`${env:NAME:-default}`.
