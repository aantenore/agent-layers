# RuntimePort

Layer: `harness` (L3 Agent runtime) · Version: 1.3.0 · Conformance: `checkRuntime`

## Purpose

Run an agent definition on any agent loop. A developer writes an agent spec once; the runtime port binds it to a loop that uses the stack's model, tools, knowledge and guards.

## Operations

- `bind(stack: Stack, agent: AgentSpec) → RunnableAgent`
  Turn an agent spec into a runnable agent wired to the ports of the stack. May be asynchronous.

A `RunnableAgent` has:

- `name: String` — equals `agent.name`.
- `run(input: RunInput, ctx?: partial CallContext) → RunResult` — run to completion.
- `stream?(input: RunInput, ctx?: partial CallContext) → stream of RunEvent` — optional, same run delivered as events.
- `resume?(checkpoint: Json, answer: ResumeAnswer, ctx?: partial CallContext) → RunResult` — optional (since 1.3.0),
  continues a `waiting` run from the checkpoint its result carried. See [Resume](#resume).

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
| `checkpoint?` | Json | What the runtime needs to continue a `waiting` run with `resume` (since 1.3.0). Opaque to the core; present only on a waiting result; kept by the host and removed before the result leaves the stack. |

Statuses: `completed` (the agent answered), `failed` (an error ended the run), `stopped` (something ended the run on purpose: a guard, a denial, a limit, a cancellation), `waiting` (the run stopped for a human answer and can be resumed).

### Stop reason

`reason` is `{code, layer?, by?, stage?, detail?}`:

| Field | Meaning |
| --- | --- |
| `code` | `guard_block`, `denied`, `aborted`, `timeout`, `limit`, `hop_limit`, `needs_input`, `needs_auth`, `rejected` or `error`. Config may add codes that behave like one of these. |
| `layer?` | Layer that stopped the run. |
| `by?` | Instance that stopped it: a guard name, an approval adapter, a remote agent, or a core check: `sdk.deadline`, `sdk.budget`, `sdk.hops`. |
| `stage?` | Guard stage, for `guard_block`. |
| `detail?` | Internal text for people. Never parsed, never shown to the caller. |

A run that waits for an approval ends with status `waiting` and reason `{code: "needs_input", layer: "identity", by: <approval instance>, detail: <approval id>}`, and the stack writes `ext["sdk.approval"] = {id, by?, tool?}` on the result: the approval id, the approval instance and the prefixed tool name, so a caller reads the id without parsing `detail` (since 1.1.0). Inside a run, a call of the stack's tools that waits for an approval throws `ApprovalPending` (from `@agent-layers/core`, like `GuardrailBlocked`) when the runtime's descriptor declares `portVersion` 1.1.0 or later; a runtime built for 1.0.0 gets the pending result instead, since it may turn a thrown tool error into tool text. A runtime may let it propagate, and the stack ends the run as above, or end the run itself with `runEndOf(err)` (status `waiting`, reason `err.stopReason`). Tools that return the pending result instead (a governed `ToolPort` outside a stack) carry `ext["sdk.approval"]` (the approval id) on the tool result, so a runtime can end the run without parsing text. A later run in the same session (same session id, same caller) that makes the same call, same tool and same arguments, gets the decision: approved runs once, denied is refused, still pending returns the same approval id (see [ApprovalPort](ApprovalPort.md)). The session carries the decision, not the conversation: `basic-runtime` and `reinloop` start each run from its input, so the follow-up message must lead the model to the same call. To continue the same run instead, use [Resume](#resume).

### Run events

`RunEvent` is `{type, at?, ...}`. Core types have fixed payloads:

| Type | Payload |
| --- | --- |
| `run.start` | `runId`, `agent` |
| `model.reply` | `turn`, `model`, `finish`, `calls` |
| `tool.call` | `id`, `tool` |
| `tool.result` | `id`, `tool`, `ok`, `durationMs?` |
| `text` | `text` |
| `run.end` | `status`, `reason?`, `usage?`, `costUsd?`, `checkpoint?` (since 1.3.0, removed by the host like the result's) |

Adapter events are named `<namespace>.<name>` (for example `reinloop.compaction`). They are stored and replayed, and never read by the core. `at` is an ISO 8601 time.

### Resume

`ResumeAnswer` is `{approval: {id, approved, reason?}}` (the decision on the approval the run waits for) or
`{input: RunInput}` (what a `needs_input` run asked for). The host continues a waiting run with `Stack.resume(runId,
answer, ctx)` ([0003](../../docs/decisions/0003-run-resume.md)):

- When a run ends `waiting`, the host keeps what continuing it needs: the run's input, its caller without the
  credential, its session, the call that waits (tool, arguments, approval id) and the runtime's `checkpoint`. In the
  stack's [StorePort](StorePort.md) when one is configured (`sdk.run.*` keys, expiring after
  `limits.run.resumeTtlMs`), else in memory (prototype).
- Only the caller that started the run (same `kind` and `id`) may resume or cancel it, unless the
  [AuthorizationPort](AuthorizationPort.md) allows the caller `decide` on the approval the run waits for (on the run,
  target kind `run`, when it waits for none). An approval answer is decided through `ApprovalPort.decide`, with `by`
  the resumer's verified identity, and needs `decide` like the gateway's approval routes, owner included. An input
  answer is refused while the run's approval is still pending.
- The run keeps its id, session and caller (the owner's fresh credential, else none), so the stack's tools find the
  decision for the call that waited. A runtime with `resume` gets the checkpoint and the answer: it runs exactly the
  call that waited, then goes on; an input answer is added to the conversation after that call's result. A runtime
  without `resume`, or a run kept without a checkpoint, is run again from its input (the input answer when there is
  one): with a real model that is not deterministic.
- `Stack.cancel(runId, {by, reason})` aborts a run in flight in this process (its signal fires, the run ends `stopped`
  with `aborted`), or marks a waiting run cancelled and withdraws its pending approval (`ApprovalPort.cancel`). A
  cancelled run cannot be resumed. Refusals are `RunRefused` with `kind` `not_found`, `forbidden`, `conflict` or
  `invalid`.

## Semantics

- The caller flows through: `ctx.caller` is passed to every model, knowledge and tool call made during the run, and its `credential` is never written to events, logs or traces.
- The runtime sees only the tools the agent's globs match, and calls them by prefixed name.
- A guardrail block ends the run with status `stopped` and a reason `{code: "guard_block", layer: "guardrail", by: <guard>, stage}`, rather than crashing the caller.
- A run honours `ctx.signal`: when it fires, the run ends as soon as it can with status `stopped` and reason `aborted` (or the stop reason the signal carries, such as `timeout`).
- Run bounds (since 1.2.0, [0002](../../docs/decisions/0002-delegation-bounds.md)): the host gives every run `ctx.bounds` (deadline, token and cost budget, hop count) from `limits.run` and what a calling agent sent (`delegation`, which only tightens them), and arms `ctx.signal` at the deadline. A run over the hop limit, or with less time left than `limits.delegation.minRemainingMs`, is refused before the runtime is called: `stopped` with `{code: "hop_limit", layer: "harness", by: "sdk.hops"}` or `{code: "timeout", ..., by: "sdk.deadline"}`. The stack's model refuses a call once the deadline has passed or the budget is spent by throwing `BoundsExceeded` (`stopReason` `timeout` or `limit`, `by: "sdk.budget"`); a runtime ends the run `stopped` with it, as `runEndOf(err)` does, or lets it through to the host. The host then reports the bound's reason, and fills `usage` and `costUsd` from the run's ledger when the runtime reports none. A runtime passes the context on (copies keep the same `bounds`) and needs no budget of its own; budgets it has (`basic-runtime` `maxTurns`, `reinloop` `budget`) are extra limits: the first one reached stops the run.
- A runtime that calls another agent (the `a2a` runtime) sends `outboundBounds(ctx)`: the time left minus `limits.delegation.marginMs`, hops plus one, a reservation of the budget, the lineage. It refuses locally, without a network call, when the call would go over the hop limit or start with too little time, and settles the reservation with the usage and cost the remote run reports.
- Session continuity (history across runs) is provided through [StatePort](StatePort.md) when the runtime supports it; the contract does not require it.
- Each run produces telemetry spans tagged with `agent.layer` (see [TelemetryPort](TelemetryPort.md)).

## Errors

- `bind` rejects when the spec cannot be honoured (unknown model setup, invalid settings).
- Run problems the agent can describe are returned as a `RunResult` with status `failed`, `stopped` or `waiting` and a structured `reason`. Cancellation does not reject: it is a `stopped` result (see Semantics).

## Escape hatch

`AgentSpec.ext` carries runtime-specific settings; `RunResult.ext` and adapter events (`<namespace>.<name>`) carry runtime-specific output. Keys and event types are namespaced and declared in the adapter descriptor's `ext.produces` / `ext.reads`. `native()` returns the underlying agent framework object. For an agent behind a remote standard (A2A), status and metadata mappings go through the stack config `mappings` block; see [Mappings](../language.md#mappings).

## Conformance

`checkRuntime` verifies:

- `bind` is a function.
- With a stack and an agent fixture: `bind` resolves, the agent's `name` equals the spec's, and `run` returns a result that validates against `run-result.json`; a result whose status is not `completed` has a `reason`. Without fixtures the run checks are skipped.
- With the fixtures, for a runtime whose descriptor declares 1.1.0 or later (`checkAdapter` reads it; `conformance` takes `portVersion` in the fixtures, default the core's): a run whose signal is already aborted resolves `stopped` with reason `aborted` (or `timeout`); a streamed run ends with a `run.end` of the run's status, and its `text` events add up to the output of a completed run (when the runtime streams); every model and tool call of a run carries the run's caller; with a `toolInput` fixture, a tool call that throws `ApprovalPending` ends the run `waiting` with `needs_input`, or lets the error through.
- With the fixtures, for a runtime declaring 1.2.0 or later: every model and tool call of a run started with `bounds` carries the run's bounds; a model call the core refuses (`BoundsExceeded`, code `limit`) ends the run `stopped` with `limit`, or the runtime lets the error through to the host.
- With a `toolInput` fixture, for a runtime declaring 1.3.0 or later that implements `resume`: a run whose tool call waits for an approval ends `waiting` with a JSON `checkpoint`; resuming it with the decision runs that call first, same tool and arguments, keeps the run id, and returns a result that validates.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.3.0 — resume ([0003](../../docs/decisions/0003-run-resume.md)): optional `RunnableAgent.resume(checkpoint, answer, ctx)` and `RunResult.checkpoint` (also on `run.end`); the host keeps waiting runs and continues them with `Stack.resume`, cancels with `Stack.cancel`; conformance checks resume when declared
- 1.2.0 — run bounds ([0002](../../docs/decisions/0002-delegation-bounds.md)): every run gets `ctx.bounds` from the host (deadline, budget, hops) and may be refused before it starts (`hop_limit`, `timeout`); the core enforces them in the governed model and tools whatever the runtime; runtimes pass the context on and end the run `stopped` on `BoundsExceeded`; conformance checks both
- 1.1.0 — the stack's tools throw `ApprovalPending` for a call waiting for an approval and the stack ends the run `waiting`; `RunResult.ext["sdk.approval"] = {id, by?, tool?}`; conformance checks abort, stream, caller and approval
- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): `AgentSpec.settings` and `ext` replace `params`; status `waiting`; structured `RunResult.reason`; core event types with fixed payloads
- 0.2.0 — optional `costUsd` on RunResult
- 0.1.0 — initial
