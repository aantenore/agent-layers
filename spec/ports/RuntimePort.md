# RuntimePort

Layer: `harness` (L3 Agent runtime) · Version: 0.1.0 · Conformance: `checkRuntime`

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
| `params?` | {String: Any} | Runtime- or model-specific parameters. |

`RunInput` is a string, or `{messages: [Message]}` using the message shape of [ModelPort](ModelPort.md).

[RunResult](../schemas/run-result.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `runId` | String, required | Run identifier. |
| `status` | String, required | `completed`, `failed` or `stopped`; other values allowed. |
| `output` | String, required | Final text. Empty when there is none. |
| `reason?` | String | Why the run stopped or failed, for example `guardrail:<guard>:<stage>`. |
| `usage?` | Usage | Token usage as in [ModelPort](ModelPort.md). |
| `events?` | [RunEvent] | `{type: String, ...}`. |

`RunEvent` is runtime-specific; `type` is the only shared field.

## Semantics

- Agent identity flows through: `ctx.identity` is passed to every model, knowledge and tool call made during the run, and its token is never written to events, logs or traces.
- The runtime sees only the tools the agent's globs match, and calls them by prefixed name.
- A guardrail block ends the run with a non-completed status and a `reason`, rather than crashing the caller.
- A run honours `ctx.signal`.
- Session continuity (history across runs) is provided through [StatePort](StatePort.md) when the runtime supports it; the contract does not require it.
- Each run produces telemetry spans tagged with `agent.layer` (see [TelemetryPort](TelemetryPort.md)).

## Errors

- `bind` rejects when the spec cannot be honoured (unknown model setup, invalid parameters).
- Run problems the agent can describe are returned as a `RunResult` with `status: failed` or `stopped` and a `reason`. Cancellation rejects.

## Escape hatch

`AgentSpec.params` carries runtime-specific settings. `RunEvent` allows extra fields. `native()` returns the underlying agent framework object.

## Conformance

`checkRuntime` verifies:

- `bind` is a function.
- With a stack and an agent fixture: `bind` resolves, the agent's `name` equals the spec's, and `run` returns a result that validates against `run-result.json`. Without fixtures the run checks are skipped.

## Version history

- 0.1.0 — initial
