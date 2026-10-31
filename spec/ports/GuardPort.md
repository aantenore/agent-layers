# GuardPort

Layer: `guardrail` (L7 Guardrails) · Version: 0.1.1 · Conformance: `checkGuard`

## Purpose

Check the text that flows through an agent and allow it, block it or rewrite it, at four points: what the user sends, what the model answers, the arguments of a tool call and the result of a tool call. A developer adds policy for content without changing prompts or tools.

Boundary: this port answers "is the content acceptable". Who may do what is decided by [AuthorizationPort](AuthorizationPort.md).

## Operations

- `check(input: GuardInput, opts?: {signal?: Signal}) → GuardVerdict`
  Inspect the text and return a verdict.

Members:

- `stages?: [Stage]` — the stages the guard runs at: `input`, `output`, `tool_args`, `tool_result`. All four when omitted.

## Data shapes

[GuardInput](../schemas/guard-request.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `stage` | `input`, `output`, `tool_args` or `tool_result`, required | Where in the run the text is. |
| `text` | String, required | Text to inspect. For `tool_args` it is the JSON-encoded arguments. |
| `agent` | String, required | Agent name. |
| `runId` | String, required | Run identifier. |
| `tool` | String | Prefixed tool name; set for `tool_args` and `tool_result`. |
| `subject` | Identity without `token` | The caller. Never contains tokens. |

No other fields are allowed.

[GuardVerdict](../schemas/guard-verdict.json): `action: allow | block | redact` (required), `text?: String` (required when `action` is `redact`: the rewritten text), `reason?: String`. No other fields.

## Semantics

- Where each stage runs: `input` on new user content before the model call; `output` on the model's text after the call (including cached responses); `tool_args` before a tool runs; `tool_result` before the result goes back to the model.
- Order: guards of a stage run in configuration order. Each sees the text as redacted by the previous one. The first `block` ends the chain.
- Fail closed: a guard that rejects or crashes counts as a block with the fixed reason `guard error`, never the error's message (it can echo the inspected text or a backend's credentials). A `redact` verdict without `text` also counts as a block.
- Effects of a block depend on the stage. At `input` and `output` the model call fails with a guardrail error and the run ends with a `guardrail:<guard>:<stage>` reason. At `tool_args` the tool is not called and the model gets an error result. At `tool_result` the result is withheld and replaced by an error result.
- A redaction of `tool_args` must still be a valid JSON object, otherwise the call is blocked.
- Streaming output is buffered when an output guard exists, so no unchecked text is released.
- A guard sees only a public identity; the raw token never reaches it.
- `check` should be deterministic for the same input, so that cached and replayed content gets the same verdict.
- Each check is a span tagged with the guard name, the stage and the action; non-allow actions are also counted.

## Errors

- Returned as a result: allow, block and redact are all results, never exceptions. A block is a decision, not a failure.
- Rejects: the guard cannot run (backend down, cancellation). The stack treats this as a block.

## Escape hatch

`reason` is free text for the audit trail. `native()` returns the underlying classifier or rule engine.

## Conformance

`checkGuard` verifies:

- Every stage in `stages` is a known stage.
- Each verdict validates against `guard-verdict.json`.
- Harmless sample text (a default sentence for each covered stage) is allowed.
- Fixture samples that must be blocked get `block`.
- Fixture samples that must be redacted get `redact`, with a rewritten `text` that no longer contains the secret.

## Version history

- 0.1.0 — initial
- 0.1.1 — the reason of a block caused by a failing guard is the fixed text `guard error`

Example adapters: `regex-guard` (maps regular expressions).
