# The stack on one page

An agent in production needs eleven layers. agent-layers names them, gives each one a port, and composes adapters
for them from a config. The core is technology neutral: every technology choice below is an adapter or a reference
setup, and each can be swapped by changing one line of config. The design is in [architecture.md](architecture.md).

![The agent-layers stack: eleven layers in six planes, one question per layer](assets/stack-overview.svg)

## Layers by plane

| Plane | L | Layer (id) | The question it answers | Ports | Reference adapters |
|---|---|---|---|---|---|
| Foundation | L0 | [Infrastructure & delivery](layers/infra.md) (`infra`) | Where does it run and how does it get there? | DeployPort, SecretPort | `compose-deploy` (Compose Spec); OpenBao, Kubernetes and OpenTofu planned |
| Model | L1 | [Models](layers/llm.md) (`llm`) | Who thinks? | ModelPort | `openai-compatible` (Ollama, vLLM, LiteLLM, hosted APIs); `mock-model` for offline work |
| Model | L2 | [Model access](layers/cache.md) (`cache`): routing, fallback, quotas, cache | Which model, at what cost and latency? | RouterPort, CachePort | `static-router`, `rule-router`, `memory-cache`; a model gateway behind `openai-compatible`; Valkey planned |
| Agent | L3 | [Agent runtime](layers/harness.md) (`harness`) | How does the agent loop run and keep state? | RuntimePort, StatePort | `basic-runtime`, `memory-state`; reinloop and agent-to-agent runtimes planned |
| Agent | L4 | [Knowledge & memory](layers/knowledge.md) (`knowledge`) | What does it know? | KnowledgePort, MemoryPort, IngestionPort | `markdown-knowledge`, `http-knowledge`, `mcp`; Qdrant, SQL, SPARQL planned |
| Agent | L5 | [Tools](layers/tool.md) (`tool`) | What can it do? | ToolPort | `functions`, `http-tools`, `mcp`, `openapi` |
| Control | L6 | [Identity & access](layers/identity.md) (`identity`) | Who is it, on whose behalf, and what is allowed? | IdentityPort, CredentialPort, AuthorizationPort, ApprovalPort | `static-identity` (dev only), `rules-authorization`, `memory-approval`, `oidc` (Keycloak or any IdP), `authzen`, `opa` |
| Control | L7 | [Guardrails](layers/guardrail.md) (`guardrail`) | Is this content acceptable? | GuardPort | `regex-guard`, `http-guard`, `presidio`, `llm-guard` |
| Experience | L8 | [Interfaces, channels & triggers](layers/interface.md) (`interface`) | Who talks to it and what starts it? | ChannelPort, TriggerPort | `terminal-channel`; on the [gateway](gateway.md): `openai-compatible`, `mcp`, `a2a`, `cloudevents` |
| Insight | L9 | [Telemetry & observability](layers/telemetry.md) (`telemetry`) | What happened? | TelemetryPort | `console-telemetry`, `jsonl-telemetry`, `otlp` (to Langfuse, Jaeger or any collector) |
| Insight | L10 | [Evaluation & improvement](layers/eval.md) (`eval`) | Was it good, and if not, which layer failed? | EvaluatorPort, FeedbackPort | `expected-eval`, `judge-eval`, `layer-signals`; promptfoo planned |

The full catalog with status and maturity is in [adapters.md](adapters.md). Layer ids are stable; the numbers are
for reading only. Reference setups (compose files and live tests) live in `reference/<layer id>/`.

Boundary rules: read-only context retrieval is `knowledge`, anything with side effects is `tool`; who may do what is
`identity`, whether the content is acceptable is `guardrail`.

## Planes at a glance

The experience plane starts runs, the control plane governs them, the agent plane does the work, the model plane
answers, the insight plane watches, and the foundation runs everything.

```mermaid
flowchart TB
  subgraph exp["Experience plane"]
    interface["L8 interface"]:::experience
  end
  subgraph ctl["Control plane"]
    identity["L6 identity"]:::control
    guardrail["L7 guardrail"]:::control
  end
  subgraph agt["Agent plane"]
    harness["L3 harness"]:::agent
    knowledge["L4 knowledge"]:::agent
    tool["L5 tool"]:::agent
  end
  subgraph mdl["Model plane"]
    cache["L2 cache"]:::model
    llm["L1 llm"]:::model
  end
  subgraph ins["Insight plane"]
    telemetry["L9 telemetry"]:::insight
    eval["L10 eval"]:::insight
  end
  subgraph fnd["Foundation: runs and delivers everything"]
    infra["L0 infra"]:::foundation
  end
  exp -->|"starts a run"| agt
  ctl -.->|"who may do what, is it acceptable"| agt
  agt -->|"model calls"| mdl
  agt -.->|"spans, events, metrics"| ins
  ins -.->|"fixes"| agt
  mdl ~~~ fnd
  classDef foundation fill:#d9dde3,stroke:#57606a,color:#1f2328
  classDef model fill:#ffd8a8,stroke:#a85400,color:#1f2328
  classDef agent fill:#a5d8ff,stroke:#1864ab,color:#1f2328
  classDef control fill:#ffc9c9,stroke:#b42318,color:#1f2328
  classDef experience fill:#b2f2bb,stroke:#2a7a38,color:#1f2328
  classDef insight fill:#d0bfff,stroke:#5f3dc4,color:#1f2328
```

## Request flow

```mermaid
flowchart TB
  client([Person, app, agent, event]) --> interface[interface<br/>channels & triggers]
  interface --> idv[identity: verify]
  idv --> harness[harness: runtime]
  harness --> guardrail[guardrail]
  harness --> knowledge[knowledge]
  harness --> tool[tool]
  ida[identity: authorize, approve,<br/>credentials on behalf of the caller] -.-> tool
  ida -.-> knowledge
  harness --> cache[cache: route, cache]
  cache --> llm[llm]
  harness -.-> telemetry[telemetry]
  guardrail -.-> telemetry
  knowledge -.-> telemetry
  tool -.-> telemetry
  cache -.-> telemetry
  llm -.-> telemetry
  telemetry --> eval[eval]
  eval -.->|fixes, regression cases| harness
  subgraph infra[infra: deploy, secrets]
    interface
  end
  class client external
  class interface experience
  class idv,ida,guardrail control
  class harness,knowledge,tool agent
  class cache,llm model
  class telemetry,eval insight
  classDef model fill:#ffd8a8,stroke:#a85400,color:#1f2328
  classDef agent fill:#a5d8ff,stroke:#1864ab,color:#1f2328
  classDef control fill:#ffc9c9,stroke:#b42318,color:#1f2328
  classDef experience fill:#b2f2bb,stroke:#2a7a38,color:#1f2328
  classDef insight fill:#d0bfff,stroke:#5f3dc4,color:#1f2328
  classDef external fill:#ffffff,stroke:#57606a,color:#1f2328,stroke-dasharray:4 3
```

A channel or trigger starts a run. Identity verifies the caller; the runtime runs the agent loop. Guardrails check
input, output and tool traffic; knowledge is retrieved with the caller's identity; tools are authorized and called
with credentials issued for the caller. Model calls go through routing and caching to the model. Every step is
traced with its layer, telemetry feeds evaluation, and evaluation sends fixes back. Infrastructure runs underneath.

## Ports and adapters

The core defines the ports. An adapter maps either an open standard or one technology's native API onto a port, and
the stack config picks one per port.

```mermaid
flowchart LR
  config["Stack config<br/>one adapter per port, per profile"]:::external
  subgraph std["Standard adapters: map an open standard"]
    openai["openai-compatible<br/>OpenAI Chat Completions"]:::external
    mcp["mcp<br/>Model Context Protocol"]:::external
    oidc["oidc<br/>OIDC, OAuth 2, RFC 8693"]:::external
    otlp["otlp<br/>OpenTelemetry GenAI"]:::external
  end
  subgraph core["Core: ports"]
    model["ModelPort"]:::model
    tools["ToolPort"]:::agent
    know["KnowledgePort"]:::agent
    ident["IdentityPort"]:::control
    authz["AuthorizationPort"]:::control
    guard["GuardPort"]:::control
    tel["TelemetryPort"]:::insight
  end
  subgraph nat["Native adapters: map one technology's API"]
    md["markdown-knowledge<br/>Markdown files"]:::external
    presidio["presidio<br/>Microsoft Presidio"]:::external
    opa["opa<br/>Open Policy Agent"]:::external
  end
  config -.-> core
  openai --- model
  mcp --- tools
  mcp --- know
  oidc --- ident
  otlp --- tel
  know --- md
  guard --- presidio
  authz --- opa
  classDef model fill:#ffd8a8,stroke:#a85400,color:#1f2328
  classDef agent fill:#a5d8ff,stroke:#1864ab,color:#1f2328
  classDef control fill:#ffc9c9,stroke:#b42318,color:#1f2328
  classDef insight fill:#d0bfff,stroke:#5f3dc4,color:#1f2328
  classDef external fill:#ffffff,stroke:#57606a,color:#1f2328,stroke-dasharray:4 3
```

## Knowledge is not only RAG

The knowledge layer covers documents, structured data, graphs and ontologies, a curated wiki, long-term memory and
procedural know-how. Each backend has its own query language (or none), so the port fixes the result instead:
`KnowledgePort.search` returns `Passage { id, text, source, score, metadata }` whatever the backend. That uniform
result lets telemetry trace and evaluation score retrieval the same way everywhere.

## Cross-cutting concerns

| Concern | Spans | Doc |
|---|---|---|
| Governance & compliance | identity, guardrail, telemetry, eval | [governance-compliance.md](cross-cutting/governance-compliance.md) |
| Security | tool, identity, guardrail | [security.md](cross-cutting/security.md) |
| Cost | harness, cache, telemetry | [cost.md](cross-cutting/cost.md) |

## Lifecycle

Design (agent file and eval cases) → build (pick adapters per layer) → test (`agent-layers test`, `eval`) → release
(`agent-layers deploy --profile production`) → operate (telemetry) → improve (eval attributes failures to a layer).
Profiles keep the same stack from prototype to production; see [guide.md](guide.md#from-prototype-to-production) and
[lifecycle.md](lifecycle.md).
