# L6 Guardrails

## Purpose

Inspect what goes into and comes out of the agent, and what tools receive and return: PII, prompt injection,
policy violations. A guard can allow, block or redact.

## Standard

None. The contract here is defined by this repository.

## Extension point

`Guard.check(GuardInput) → GuardVerdict`, running at four stages: `input`, `output`, `tool_args`, `tool_result`.

## Reference implementation

| Role | Reference | License |
|---|---|---|
| PII detection and redaction | Microsoft Presidio (analyzer + anonymizer) | MIT |
| Prompt injection, toxicity, etc. | LLM Guard API | MIT |

Llama Guard is deliberately not used: it is under the Llama Community License, which is not OSI-approved.

## How to swap it

Any service that accepts a `GuardInput` as a JSON `POST` and answers with a `GuardVerdict` works through the
built-in `http` adapter, in any language. A JS function works through the `js` adapter. Built-in adapters:
`presidio`, `llm-guard`, `http`, `js`.

## Contract

```ts
interface Guard { check(input: GuardInput): Promise<GuardVerdict> }
// GuardInput   { stage, text, agent, runId, tool?, subject? }
// GuardVerdict { action: 'allow' | 'block' | 'redact', text?, reason? }
```

- `block` on `input` / `output` ends the run: status `stopped`, reason `guardrail:<guard>:<stage>`.
- `block` on `tool_args` denies the call.
- `redact` replaces the text with `GuardVerdict.text`.

Schemas: [guard-request.json](../../contracts/guard-request.json), [guard-verdict.json](../../contracts/guard-verdict.json).
Details in [contracts.md](../contracts.md#l6-guardrails).

## Adapter SDK

The `Guard` interface, the HTTP guard contract above, and a conformance check: known-bad and known-good samples per
stage, verified against the verdict schema and expected actions.

## How to test

```bash
make up LAYER=l6-guardrails
make test LAYER=l6-guardrails
make down LAYER=l6-guardrails
```

Variables: `PRESIDIO_ANALYZER_URL`, `PRESIDIO_ANONYMIZER_URL`, `LLM_GUARD_URL`, `LLM_GUARD_TOKEN`.
