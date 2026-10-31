# Contracts

Single source of truth for the interfaces between layers. Layer docs link here; if something disagrees with this
file, this file wins. JSON Schemas (draft 2020-12) for the data shapes live in [`../contracts/`](../contracts).

Interfaces are written in TypeScript because the reference runtime is. The wire formats (HTTP, MCP, JSONL) are
language neutral.

## Host ports and environment

All values are defaults for local development and live in [`.env.example`](../.env.example).

| L | Variable | Default |
|---|---|---|
| 1 | `LLM_BASE_URL` | `http://localhost:11434/v1` |
| 1 | `LLM_MODEL` | `qwen2.5:3b` |
| 1 | `LLM_API_KEY` | `ollama` |
| 2 | `REINLOOP_SERVE_PORT` | `8700` |
| 3 | `QDRANT_URL` | `http://localhost:6333` |
| 3 | `QDRANT_COLLECTION` | `docs` |
| 3 | `WIKI_DIR` | `layers/l3-knowledge/wiki` |
| 4 | `HTTPBIN_URL` | `http://localhost:8085` |
| 4 | `OPENAPI_MCP_URL` | `http://localhost:8090/mcp` |
| 5 | `OIDC_ISSUER` | `http://localhost:8080/realms/agents` |
| 5 | `OIDC_CLIENT_ID` | `agent-runtime` |
| 5 | `OIDC_CLIENT_SECRET` | `change-me` |
| 5 | `TOOLS_AUDIENCE` | `tools-api` |
| 5 | `OPA_URL` | `http://localhost:8181` |
| 6 | `PRESIDIO_ANALYZER_URL` | `http://localhost:5002` |
| 6 | `PRESIDIO_ANONYMIZER_URL` | `http://localhost:5001` |
| 6 | `LLM_GUARD_URL` | `http://localhost:8000` |
| 6 | `LLM_GUARD_TOKEN` | `change-me` |
| 7 | `GATEWAY_URL` | `http://localhost:4000/v1` |
| 7 | `GATEWAY_KEY` | `sk-local-change-me` |
| 7 | `VALKEY_URL` | `redis://localhost:6379` |
| 8 | `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` |
| 8 | `LANGFUSE_URL` | `http://localhost:3000` |
| 8 | `LANGFUSE_PUBLIC_KEY` | `pk-lf-local` |
| 8 | `LANGFUSE_SECRET_KEY` | `sk-lf-local` |
| 8 | `JAEGER_UI` | `http://localhost:16686` |
| 9 | `EVAL_DATASET` | `layers/l9-eval/datasets/smoke.jsonl` |

Ollama runs natively on the host. Containers reach it at `host.docker.internal:11434`.

## L1 LLM

- In: OpenAI chat completions request, with `tools`.
- Out: completion with `tool_calls` and `usage`.
- Any provider behind an OpenAI- or Anthropic-compatible URL is a drop-in. Anything else implements reinloop
  `Provider` (`generate(request, { signal, onText })`).

## L2 Harness

- In: agent file + input (+ identity).
- Out: a `RunEvent` stream that ends in `run_end { status, output, usage, costUsd }`.
- HTTP: `reinloop serve` (port 8700).

## L3 Knowledge

```ts
interface KnowledgeSource {
  search(q: { query: string; k?: number; filter?: object; identity?: Identity }): Promise<Passage[]>;
}
interface Passage { id: string; text: string; source?: string; score?: number; metadata?: object }
```

Schema: [`passage.json`](../contracts/passage.json).

Wire options:

1. An MCP tool that returns passages (Qdrant: `qdrant-find`).
2. HTTP: `POST {url}` with `{query, k, filter}` returns `{passages: Passage[]}`.
3. A JS function.

The reinloop `knowledge` middleware injects the top-k passages before the model call as a delimited context block
that is marked untrusted.

## L4 Tools

- MCP: stdio and streamable HTTP.
- Declarative HTTP tools in the reinloop config:

  ```
  httpTools.<name> = {
    description, method, url (with {param} placeholders),
    query?, headers? (${env:X}), body?: 'json' | 'none',
    schema, risk, timeoutMs?, auth?: { audience }
  }
  ```

- OpenAPI 3 (JSON) import generates HTTP tools.
- Any JS function through `defineTool`.
- Tool results are strings, plus optional `data`.

## L5 Identity and access

Inbound: `Authorization: Bearer <JWT>`, verified through OIDC discovery and JWKS (`IdentityVerifier`).

```ts
interface Identity { subject: string; kind: 'user' | 'agent'; roles: string[]; scopes: string[]; claims: object }
```

Outbound: `CredentialProvider.token(audience)`.

| Mode | Mechanism |
|---|---|
| `on-behalf-of` | RFC 8693 token exchange; the caller's token is the `subject_token` |
| `self` | OAuth 2 `client_credentials`; the agent's own identity |

Authorization runs in two steps:

1. Local policy rules: `allow` / `ask` / `deny` by tool, risk and `when: { roles, scopes, kind }`.
2. An external `Authorizer`.

AuthZEN: `POST /access/v1/evaluation` with an `AccessRequest`:

```json
{
  "subject":  { "type": "user", "id": "<subject>", "properties": { "roles": [], "scopes": [] } },
  "action":   { "name": "call" },
  "resource": { "type": "tool", "id": "<tool>", "properties": { "risk": "read", "agent": "<agent>" } },
  "context":  { "args": {} }
}
```

Response: `{ "decision": true|false, "context": { "reason": "..." } }` (`context.reason` optional).

OPA adapter: `POST {OPA_URL}/v1/data/agents/allow` with `{ "input": <AccessRequest> }`. Response `{ "result": boolean }` or
`{ "result": { "allow": boolean, "reason"?: string } }`.

Schemas: [`access-request.json`](../contracts/access-request.json), [`access-decision.json`](../contracts/access-decision.json).

Tokens never appear in events, logs or traces.

## L6 Guardrails

```ts
interface Guard { check(input: GuardInput): Promise<GuardVerdict> }
interface GuardInput {
  stage: 'input' | 'output' | 'tool_args' | 'tool_result';
  text: string; agent: string; runId: string; tool?: string; subject?: Identity;
}
interface GuardVerdict { action: 'allow' | 'block' | 'redact'; text?: string; reason?: string }
```

Schemas: [`guard-request.json`](../contracts/guard-request.json), [`guard-verdict.json`](../contracts/guard-verdict.json).

HTTP guard contract: `POST {url}` with a `GuardInput` body, answered with a `GuardVerdict`.

Built-in adapters: `presidio`, `llm-guard`, `http`, `js`.

Effects:

- `block` on `input` or `output` ends the run with status `stopped` and reason `guardrail:<guard>:<stage>`.
- `block` on `tool_args` denies the call.
- `redact` rewrites the text with `GuardVerdict.text`.

## L7 Cache and router

- Gateway: a transparent OpenAI-compatible endpoint at `GATEWAY_URL` (LiteLLM: model groups, fallbacks, Valkey exact cache).
- In process: reinloop `responseCache` (`CacheStore`) and `ModelRouter.select(req) → model`.

## L8 Telemetry

- OTLP/HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Spans follow the GenAI semantic conventions: `invoke_agent`, `chat`, `execute_tool`. Each span also carries
  `agent.layer`, one of: `infra`, `llm`, `harness`, `knowledge`, `tool`, `identity`, `guardrail`, `cache`,
  `telemetry`, `eval` (the `Layer` enum).
- Metrics: `gen_ai.client.token.usage`, `gen_ai.client.operation.duration`, `agent.tool.calls`, `agent.cost.usd`,
  `agent.policy.decisions`, `agent.guardrail.actions`.
- The collector fans out to Langfuse and Jaeger.

## L9 Evaluation

- Dataset: JSONL of `EvalCase { id, input, expected?, tags?, layer? }` ([`eval-case.json`](../contracts/eval-case.json)).
- Results: JSONL of `{ id, runId, output, status, scores: EvalScore[] }` with
  `EvalScore { metric, value, layer?, reason? }` ([`eval-result.json`](../contracts/eval-result.json)).
- `Evaluator.score(case, run) → EvalScore[]`.
- The promptfoo provider calls reinloop.
- `reinloop replay` re-runs stored inputs with another agent or model.
- The diagnose agent outputs `{ runId, layer, evidence, fix }`.
