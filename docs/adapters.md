# Adapters

Every implementation is an adapter: a package `@agent-layers/adapter-<name>` that maps an open standard, or a
technology's native API when no standard exists, onto a port. Adapters are independent packages, so each can have
its own maintainer and release cadence. How to write one: [guide.md](guide.md#write-an-adapter) and
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Maturity

| Level | Criteria |
|---|---|
| experimental | Descriptor and conformance test pass. Behaviour may change. |
| beta | Conformance passing in CI, a pinned upstream version (where there is an upstream) with a live contract test, an owner in CODEOWNERS. |
| stable | Beta for at least one minor release of its port without breaking changes, documented options, used in a reference setup. |

## Catalog

Direction: **outbound** consumes a standard or technology as a port; **inbound** exposes the stack through one.
Tiers: **prototype** adapters are for laptops, tests and demos; **production** adapters can run in production. The
readiness gate (`agent-layers check --profile <p>`) rejects prototype-only adapters on production-tier profiles.

### Available (zero dependencies)

| Adapter | Direction | Port | Layer | Maps | Tiers | Maturity |
|---|---|---|---|---|---|---|
| `compose-deploy` | outbound | DeployPort | infra | standard: Compose Specification | prototype, production | experimental |
| `mock-model` | outbound | ModelPort | llm | technology: scripted deterministic model | prototype | experimental |
| `openai-compatible` | outbound | ModelPort | llm | standard: OpenAI Chat Completions | prototype, production | experimental |
| `static-router` | outbound | RouterPort | cache | technology: static model mapping | prototype, production | experimental |
| `memory-cache` | outbound | CachePort | cache | technology: in-process map | prototype | experimental |
| `basic-runtime` | outbound | RuntimePort | harness | technology: in-process tool-calling loop | prototype | experimental |
| `memory-state` | outbound | StatePort | harness | technology: in-process map | prototype | experimental |
| `markdown-knowledge` | outbound | KnowledgePort | knowledge | technology: Markdown files | prototype, production | experimental |
| `functions` | outbound | ToolPort | tool | technology: JavaScript functions | prototype, production | experimental |
| `static-identity` | outbound | IdentityPort, CredentialPort | identity | technology: static token table (development only) | prototype | experimental |
| `rules-authorization` | outbound | AuthorizationPort | identity | technology: local rule list | prototype, production | experimental |
| `memory-approval` | outbound | ApprovalPort | identity | technology: in-process store | prototype | experimental |
| `regex-guard` | outbound | GuardPort | guardrail | technology: regular expressions | prototype | experimental |
| `terminal-channel` | inbound | ChannelPort | interface | technology: terminal (stdin/stdout) | prototype | experimental |
| `console-telemetry` | outbound | TelemetryPort | telemetry | technology: terminal output | prototype | experimental |
| `jsonl-telemetry` | outbound | TelemetryPort | telemetry | technology: JSON Lines files | prototype, production | experimental |
| `expected-eval` | outbound | EvaluatorPort | eval | technology: expected answers | prototype, production | experimental |

`adapters/_template` is a copyable skeleton (a word-list guard), not a published adapter.

### Planned

| Adapter | Direction | Port | Layer | Maps | Notes |
|---|---|---|---|---|---|
| `openbao` | outbound | SecretPort | infra | standard: Vault-compatible secrets API | |
| `kubernetes` | outbound | DeployPort | infra | standard: Kubernetes API / Helm | |
| `openai-compatible` (server) | inbound | ChannelPort | interface | standard: OpenAI Chat Completions | hosted by the gateway |
| `valkey` | outbound | CachePort | cache | technology: Valkey | |
| `reinloop` | outbound | RuntimePort | harness | technology: reinloop | first full runtime |
| `a2a` | outbound / inbound | RuntimePort, ChannelPort | harness, interface | standard: A2A | remote agents in any language; agent endpoints |
| `postgres-state` | outbound | StatePort | harness | technology: PostgreSQL | |
| `mcp` | outbound / inbound | ToolPort, KnowledgePort, ChannelPort | tool, knowledge, interface | standard: MCP | MCP servers as tools or knowledge; the stack as an MCP server |
| `openapi` | outbound | ToolPort | tool | standard: OpenAPI 3 | |
| `qdrant` | outbound | KnowledgePort, IngestionPort | knowledge | technology: Qdrant | |
| `sql`, `sparql` | outbound | KnowledgePort | knowledge | standard: SQL, SPARQL 1.1 | |
| `oidc` | outbound | IdentityPort, CredentialPort | identity | standard: OIDC, RFC 8693, client credentials | Keycloak, Entra ID, Auth0, ... |
| `authzen`, `opa` | outbound | AuthorizationPort | identity | standard: OpenID AuthZEN; technology: OPA | |
| `presidio`, `llm-guard` | outbound | GuardPort | guardrail | technology: Presidio, LLM Guard | |
| `http-guard` | outbound | GuardPort | guardrail | standard: guard-request / guard-verdict JSON over HTTP (`spec/schemas`) | guards in any language |
| `cloudevents` | inbound | TriggerPort | interface | standard: CloudEvents | |
| `otlp` | outbound | TelemetryPort | telemetry | standard: OTLP + GenAI semantic conventions | Langfuse, Jaeger, any collector |
| `judge`, `promptfoo` | outbound | EvaluatorPort | eval | technology: model-as-judge, promptfoo | |

Technologies that speak a standard need no adapter of their own: Keycloak through `oidc`; Ollama, vLLM, LiteLLM and
hosted APIs through `openai-compatible`; Langfuse and Jaeger through `otlp`.
