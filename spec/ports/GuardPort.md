# GuardPort

Layer: `guardrail` (L7 Guardrails) · Version: 1.0.0 · Conformance: `checkGuard`

## Purpose

Check the text that flows through an agent and allow it, block it or rewrite it, at four points: what the user sends, what the model answers, the arguments of a tool call and the result of a tool call. A developer adds policy for content without changing prompts or tools.

Boundary: this port answers "is the content acceptable". Who may do what is decided by [AuthorizationPort](AuthorizationPort.md).

## Operations

- `check(input: GuardCheck, opts?: {signal?: Signal}) → GuardVerdict`
  Inspect the text and return a verdict.

Members:

- `stages?: [Stage]` — the stages the guard runs at: `input`, `output`, `tool_args`, `tool_result`. All four when omitted.

## Data shapes

[GuardCheck](../schemas/guard-check.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `stage` | `input`, `output`, `tool_args` or `tool_result`, required | Where in the run the text is. |
| `text` | String, required | Text to inspect. For `tool_args` it is the JSON-encoded arguments. |
| `agent` | String, required | Agent name. |
| `runId` | String, required | Run identifier. |
| `tool?` | String | Prefixed tool name; set for `tool_args` and `tool_result`. |
| `caller?` | public [Caller](../schemas/caller.json) | The caller, without `credential`. |
| `ext?` | Ext | Adapter-specific context. |

[GuardVerdict](../schemas/guard-verdict.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `action` | `allow`, `block` or `redact`, required | The decision. |
| `text?` | String | Required when `action` is `redact`: the rewritten text. |
| `labels?` | [String] | What was found: `pii`, `secret`, `injection`, `toxicity`, `policy` or `other`. Config may add labels that behave like one of these (for example `pii.health` like `pii`). Native names (a detector's entity types) go in `ext`. |
| `reason?` | String | Human text for the audit trail, internal only. Never parsed. |
| `ext?` | Ext | Detector-specific fields. |

## Semantics

- Where each stage runs: `input` on new user content before the model call; `output` on the model's text after the call (including cached replies); `tool_args` before a tool runs; `tool_result` before the result goes back to the model.
- Order: guards of a stage run in configuration order. Each sees the text as redacted by the previous one. The first `block` ends the chain.
- Fail closed: a guard that rejects or crashes counts as a block with the fixed reason `guard error`, never the error's message (it can echo the inspected text or a backend's credentials). A `redact` verdict without `text` also counts as a block.
- Effects of a block depend on the stage. At `input` and `output` the model call fails with a guardrail error and the run ends with status `stopped` and reason `{code: "guard_block", layer: "guardrail", by: <guard>, stage}`. At `tool_args` the tool is not called and the model gets a result with `ok: false`. At `tool_result` the result is withheld and replaced by a result with `ok: false`.
- A redaction of `tool_args` must still be a valid JSON object, otherwise the call is blocked.
- Streaming output is buffered when an output guard exists, so no unchecked text is released.
- A guard sees only the public caller; the raw `credential` never reaches it.
- `check` should be deterministic for the same input, so that cached and replayed content gets the same verdict.
- Each check is an `agent.guard.check` span tagged with the guard name, the stage and the action; non-allow actions are also counted.
- Nothing reads `reason`: telemetry, evaluation and the run reason use `action`, `labels` and the guard name.

## Errors

- Returned as a result: allow, block and redact are all results, never exceptions. A block is a decision, not a failure.
- Rejects: the guard cannot run (backend down, cancellation). The stack treats this as a block.

## Escape hatch

`ext` on the verdict carries detector-specific findings (for example a detector's native entity types, in the adapter's namespace); keys are namespaced and declared in the adapter descriptor's `ext.produces` / `ext.reads`. `native()` returns the underlying classifier or rule engine. Mapping a detector's finding types to `labels` goes through the stack config `mappings` block (`guardrails.<name>`); see [Mappings](../language.md#mappings).

## Conformance

`checkGuard` verifies:

- Every stage in `stages` is a known stage.
- Each verdict validates against `guard-verdict.json`.
- Harmless sample text (a default sentence for each covered stage) is allowed.
- Fixture samples that must be blocked get `block`.
- Fixture samples that must be redacted get `redact`, with a rewritten `text` that no longer contains the secret.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): `GuardCheck` (was `GuardInput`) with `caller`; verdict `labels` from the guard label vocabulary; `reason` is never parsed
- 0.1.1 — the reason of a block caused by a failing guard is the fixed text `guard error`
- 0.1.0 — initial

Example adapters: `regex-guard` (maps regular expressions).
