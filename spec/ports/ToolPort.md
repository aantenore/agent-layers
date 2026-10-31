# ToolPort

Layer: `tool` (L5 Tools) · Version: 0.1.0 · Conformance: `checkTools`

## Purpose

Let an agent do things: call functions, services or other agents through one listing operation and one call operation. A developer adds a tool source by configuration; the stack governs every call.

Boundary: anything with side effects is a tool. Read-only context retrieval is [knowledge](KnowledgePort.md); a read-only tool that fetches context may set `layer: knowledge` on its spec so telemetry attributes it correctly.

## Operations

- `listTools(ctx: CallContext) → [ToolSpec]`
  Describe the tools this source offers to the caller in `ctx`.
- `callTool(name: String, args: {String: Any}, ctx: CallContext) → ToolOutcome`
  Run one tool with the given arguments and return its outcome.

`CallContext` is in the [port index](README.md#common-types). A tool that calls a protected service obtains outbound tokens from `ctx.credentials`.

## Data shapes

[ToolSpec](../schemas/tool-spec.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | String, required | Matches `^[A-Za-z0-9_.-]+$`. Unique within the source. |
| `description` | String, required | Shown to the model. |
| `inputSchema` | object, required | Schema of the arguments object. |
| `layer?` | Layer id | Layer the tool belongs to when it is not a plain tool, for example `knowledge`. |
| `risk?` | `read`, `write` or `exec` | Risk class used by policy. Missing means `exec`. |
| `audience?` | String | Audience a credential is needed for, when the tool calls a protected service. |
| `meta?` | {String: Any} | Technology-specific metadata. |

[ToolOutcome](../schemas/tool-outcome.json): `content: String` (required, what the model sees), `data?: Any` (structured result), `isError?: Boolean`.

## Semantics

- Naming: a source lists plain names. When the stack aggregates several sources it exposes each tool as `<source>__<tool>` (the separator is configurable, `__` by default), and agents' tool globs, policy rules and authorization requests all use these prefixed names.
- Risk: a tool without `risk` is treated as `exec`, the most dangerous class. Declare `read` only for tools that cannot change anything.
- Governed call, in order: local policy rules (first match decides: allow, ask, deny) → human approval when the effect is `ask` (without an approval port, `ask` denies; a call waits only up to the configured time and otherwise fails as pending) → authorization decision (an error denies) → guards on the arguments (`tool_args`; a redaction replaces the arguments and must stay valid JSON) → the tool call with bound credentials → guards on the result (`tool_result`). Policy and authorization are described in [AuthorizationPort](AuthorizationPort.md) and [ApprovalPort](ApprovalPort.md); guards in [GuardPort](GuardPort.md).
- Denials and guardrail blocks are error results (`isError: true`), so the model can react. They are not exceptions.
- Aborts propagate: a cancelled call rejects.
- Tokens obtained for a tool are never placed in `content`, `data`, logs or traces.
- Listing is by caller: a source may return different tools for different identities.

## Errors

- Returned as a result with `isError: true`: unknown tool name, invalid arguments, the tool failed, denial by policy, block by a guard. An adapter must not throw for an unknown tool.
- Rejects: the source is unreachable, or the call was cancelled.

## Escape hatch

`ToolSpec.meta` carries technology-specific metadata. `ToolOutcome.data` carries structured output next to the text. `native()` returns the underlying client or registry.

## Conformance

`checkTools` verifies:

- `listTools` returns specs that validate against `tool-spec.json`, with unique names.
- `callTool` on an unknown name returns `isError: true` instead of throwing.
- For each fixture call: the outcome validates against `tool-outcome.json`, its content contains the expected text, and `isError` matches the expectation.

## Version history

- 0.1.0 — initial

Example adapters: `functions` (maps plain functions).
