# RuntimePort

Layer: `harness` (L3 Agent runtime) · Version: 1.0.0 · Conformance: `checkRuntime`

## Purpose

Run an agent definition on any agent loop. A developer writes an agent spec once; the runtime port binds it to a loop that uses the stack's model, tools, knowledge and guards.

## Operations

- `bind(stack: Stack, agent: AgentSpec) → RunnableAgent`
  Turn an agent spec into a runnable agent wired to the ports of the stack. May be asynchronous.

A `RunnableAgent` has:

- `name: String` — equals `agent.name`.
- `run(input: RunInput, ctx?: partial CallContext) → RunResult` — run to completion.
- `stream?(input: RunInput, ctx?: partial CallContext) → stream of RunEvent` — optional, same run delivered as events.

`Stack` is the set of configured port instances of the deployment, already composed: a model with knowledge injection, guards, cache and router applied; tools prefixed and governed; telemetry fan-out. The runtime uses these and does not re-implement the composition. `CallContext` is in the [port index](README.md#common-types).

## Data shapes

[AgentSpec](../schemas/agent-spec.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | String, required, non-empty | Agent name. |
| `instructions` | String, required | System instructions. |
| `model` | String, required | Model id requested for the agent. |
| `tools` | [String], required | Tool name globs, matched against prefixed names (`<source>__<tool>`). |
| `knowledge?` | [String] | Knowledge source names injected before model calls; all configured sources when omitted. |
| `settings?` | `{temperature?, maxOutputTokens?, stop?}` | Sampling settings, the same shape as `ModelRequest.settings` in [ModelPort](ModelPort.md). |
| `ext?` | Ext | Runtime- or adapter-specific settings, namespaced. |

`params` was removed at 1.0: an agent file that still has it is rejected with an error that names `settings` and `ext`.

`RunInput` is a string, or `{messages: [Message]}` using the message shape of [ModelPort](ModelPort.md).

[RunResult](../schemas/run-result.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `runId` | String, required | Run identifier. |
| `status` | String, required | `completed`, `failed`, `stopped` or `waiting`. |
| `output` | String, required | Final text. Empty when there is none. |
| `reason?` | [StopReason](#stop-reason) | Why the run did not complete. Required when `status` is not `completed`. |
| `usage?` | `{inputTokens, outputTokens}` | Token usage as in [ModelPort](ModelPort.md). |
| `costUsd?` | Number, >= 0 | What the run cost in US dollars, summed over its model calls. Present when the runtime knows the prices of the models it called, or a remote agent reports it; absent when unknown (not 0). |
| `events?` | [[RunEvent](../schemas/run-event.json)] | What happened during the run. |
| `ext?` | Ext | Adapter-specific fields. |

Statuses: `completed` (the agent answered), `failed` (an error ended the run), `stopped` (something ended the run on purpose: a guard, a denial, a limit, a cancellation), `waiting` (the run stopped for a human answer and can be resumed).

### Stop reason

`reason` is `{code, layer?, by?, stage?, detail?}`:

| Field | Meaning |
| --- | --- |
| `code` | `guard_block`, `denied`, `aborted`, `timeout`, `limit`, `needs_input`, `needs_auth`, `rejected` or `error`. Config may add codes that behave like one of these. |
| `layer?` | Layer that stopped the run. |
| `by?` | Instance that stopped it: a guard name, an approval adapter, a remote agent. |
| `stage?` | Guard stage, for `guard_block`. |
| `detail?` | Internal text for people. Never parsed, never shown to the caller. |

A run that waits for an approval ends with status `waiting` and reason `{code: "needs_input", layer: "identity", by: <approval instance>, detail: <approval id>}`. The governed tool result that asked for the approval carries `ext["sdk.approval"]` (the approval id), so a runtime can end the run without parsing text. A later run in the same session (same session id, same caller) that makes the same call, same tool and same arguments, gets the decision: approved runs once, denied is refused, still pending returns the same approval id (see [ApprovalPort](ApprovalPort.md)). The session carries the decision, not the conversation: `basic-runtime` and `reinloop` start each run from its input, so the follow-up message must lead the model to the same call.

### Run events

`RunEvent` is `{type, at?, ...}`. Core types have fixed payloads:

| Type | Payload |
| --- | --- |
| `run.start` | `runId`, `agent` |
| `model.reply` | `turn`, `model`, `finish`, `calls` |
| `tool.call` | `id`, `tool` |
| `tool.result` | `id`, `tool`, `ok`, `durationMs?` |
| `text` | `text` |
| `run.end` | `status`, `reason?`, `usage?`, `costUsd?` |

Adapter events are named `<namespace>.<name>` (for example `reinloop.compaction`). They are stored and replayed, and never read by the core. `at` is an ISO 8601 time.

## Semantics

- The caller flows through: `ctx.caller` is passed to every model, knowledge and tool call made during the run, and its `credential` is never written to events, logs or traces.
- The runtime sees only the tools the agent's globs match, and calls them by prefixed name.
- A guardrail block ends the run with status `stopped` and a reason `{code: "guard_block", layer: "guardrail", by: <guard>, stage}`, rather than crashing the caller.
- A run honours `ctx.signal`.
- Session continuity (history across runs) is provided through [StatePort](StatePort.md) when the runtime supports it; the contract does not require it.
- Each run produces telemetry spans tagged with `agent.layer` (see [TelemetryPort](TelemetryPort.md)).

## Errors

- `bind` rejects when the spec cannot be honoured (unknown model setup, invalid settings).
- Run problems the agent can describe are returned as a `RunResult` with status `failed`, `stopped` or `waiting` and a structured `reason`. Cancellation rejects.

## Escape hatch

`AgentSpec.ext` carries runtime-specific settings; `RunResult.ext` and adapter events (`<namespace>.<name>`) carry runtime-specific output. Keys and event types are namespaced and declared in the adapter descriptor's `ext.produces` / `ext.reads`. `native()` returns the underlying agent framework object. For an agent behind a remote standard (A2A), status and metadata mappings go through the stack config `mappings` block; see [Mappings](../language.md#mappings).

## Conformance

`checkRuntime` verifies:

- `bind` is a function.
- With a stack and an agent fixture: `bind` resolves, the agent's `name` equals the spec's, and `run` returns a result that validates against `run-result.json`; a result whose status is not `completed` has a `reason`. Without fixtures the run checks are skipped.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): `AgentSpec.settings` and `ext` replace `params`; status `waiting`; structured `RunResult.reason`; core event types with fixed payloads
- 0.2.0 — optional `costUsd` on RunResult
- 0.1.0 — initial
