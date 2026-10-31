# Guardrails

Layer id `guardrail` (L7), Control plane. *Is this content acceptable?*

## Responsibility

Inspect what goes into and comes out of the agent, and what tools receive and return: PII, prompt injection, policy
violations. A guard can allow, block or redact.

## Ports

| Port | What it does |
|---|---|
| [GuardPort](../../spec/ports/GuardPort.md) | `check` a `GuardCheck` at one of four stages and return a `GuardVerdict` |

Stages: `input`, `output`, `tool_args`, `tool_result`. Data shapes: [guard-check.json](../../spec/schemas/guard-check.json),
[guard-verdict.json](../../spec/schemas/guard-verdict.json). `GuardCheck.caller` is the caller without its credential
(a public caller, an object, not a string). A verdict may carry `labels` (`pii`, `secret`, `injection`, `toxicity`,
`policy`, `other`, plus values the config adds) saying what was found; an engine's own names, such as Presidio entity
types, go in `ext`.

### Where it sits

```mermaid
flowchart LR
  gm["guardedModel<br/>stages input, output"]:::model --> gp
  gt["governedTools<br/>stages tool_args, tool_result"]:::agent --> gp
  subgraph sg["L7 guardrail"]
    gp["GuardPort<br/>check"]:::control
  end
  gp --> engines["regex-guard, presidio,<br/>llm-guard, http-guard"]:::external
  gp -.->|"agent.guard.check span, actions"| telemetry["L9 telemetry"]:::insight
  classDef model fill:#ffd8a8,stroke:#a85400,color:#1f2328
  classDef agent fill:#a5d8ff,stroke:#1864ab,color:#1f2328
  classDef control fill:#ffc9c9,stroke:#b42318,color:#1f2328
  classDef insight fill:#d0bfff,stroke:#5f3dc4,color:#1f2328
  classDef external fill:#ffffff,stroke:#57606a,color:#1f2328,stroke-dasharray:4 3
```

## Standards

None. The contract is defined by this repository; any service that accepts a `GuardCheck` as a JSON `POST` and answers
with a `GuardVerdict` can be a guard, in any language.

## Where guards run

Four stages cover the model and the tool traffic. The verdict decides what happens next.

```mermaid
flowchart LR
  user(["User message"]):::external --> gin["guard: input"]:::control
  gin --> model["L1 llm"]:::model
  model -->|"tool call"| gargs["guard: tool_args"]:::control
  gargs --> tool["L5 tool"]:::agent
  tool --> gres["guard: tool_result"]:::control
  gres --> model
  model --> gout["guard: output"]:::control
  gout --> answer(["Answer"]):::external
  classDef model fill:#ffd8a8,stroke:#a85400,color:#1f2328
  classDef agent fill:#a5d8ff,stroke:#1864ab,color:#1f2328
  classDef control fill:#ffc9c9,stroke:#b42318,color:#1f2328
  classDef external fill:#ffffff,stroke:#57606a,color:#1f2328,stroke-dasharray:4 3
```

```mermaid
flowchart LR
  verdict{"GuardVerdict"}:::control
  verdict -->|"allow"| pass["text continues"]:::external
  verdict -->|"redact"| red["text replaced,<br/>next guard sees the new text"]:::external
  verdict -->|"block"| blk{"stage"}:::control
  blk -->|"input, output"| stop["run stopped<br/>guard_block, by guard, stage"]:::external
  blk -->|"tool_args"| den["call denied"]:::external
  blk -->|"tool_result"| wh["result withheld"]:::external
  classDef control fill:#ffc9c9,stroke:#b42318,color:#1f2328
  classDef external fill:#ffffff,stroke:#57606a,color:#1f2328,stroke-dasharray:4 3
```

## Boundaries

- Whether the content is acceptable is guardrail; who may do what is [identity](identity.md).
- `block` on `input` or `output` ends the run with status `stopped` and the structured reason `{ code: "guard_block", layer: "guardrail", by: <guard>, stage }`; on
  `tool_args` the call is denied; on `tool_result` the result is withheld. `redact` replaces the text.
- Guards of a stage run in configuration order; a guard that fails counts as a block (fail closed).
- Every block and redact is emitted to [telemetry](telemetry.md) (`agent.guard.action`, `agent.guard.actions`) without the sensitive text.

## How to swap

Any HTTP guard works through `http-guard`; a function or a local classifier is an adapter on GuardPort, checked with
the conformance suite (known-good and known-bad samples per stage). Other engines (NeMo Guardrails, Guardrails AI,
Granite Guardian) fit behind a small HTTP shim.

## Reference adapters

| Adapter | Maps |
|---|---|
| `regex-guard` | Regular expressions (emails, keys, simple injection phrases); coarse, but works everywhere |
| `http-guard` | The guard HTTP contract |
| `presidio` | Microsoft Presidio analyzer and anonymizer (PII) |
| `llm-guard` | LLM Guard API (prompt injection, secrets) |

Full list: [adapters.md](../adapters.md).

## Reference setup

[`reference/guardrail/`](../../reference/guardrail/README.md) runs Presidio (MIT) and LLM Guard (MIT). Llama Guard is
deliberately not used: it is under the Llama Community License, which is not OSI-approved. Variables:
`PRESIDIO_ANALYZER_URL`, `PRESIDIO_ANONYMIZER_URL`, `LLM_GUARD_URL`, `LLM_GUARD_TOKEN`.

```bash
make up LAYER=guardrail
make test LAYER=guardrail
make down LAYER=guardrail
```
