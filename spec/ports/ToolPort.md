# ToolPort

Layer: `tool` (L5 Tools) · Version: 1.0.0 · Conformance: `checkTools`

## Purpose

Let an agent do things: call functions, services or other agents through one listing operation and one call operation. A developer adds a tool source by configuration; the stack governs every call.

Boundary: anything with side effects is a tool. Read-only context retrieval is [knowledge](KnowledgePort.md); a read-only tool that fetches context may set `layer: knowledge` on its spec so telemetry attributes it correctly.

## Operations

- `listTools(ctx: CallContext) → [ToolSpec]`
  Describe the tools this source offers to the caller in `ctx`.
- `callTool(name: String, args: {String: Any}, ctx: CallContext) → ToolResult`
  Run one tool with the given arguments and return its result.

`CallContext` is in the [port index](README.md#common-types). A tool that calls a protected service obtains outbound tokens from `ctx.credentials`.

## Data shapes

[ToolSpec](../schemas/tool-spec.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | String, required | Matches `^[A-Za-z0-9_.-]+$`. Unique within the source. |
| `description` | String, required | Shown to the model. |
| `params` | JSON Schema (object), required | Schema of the arguments object. |
| `layer?` | Layer id | Layer the tool belongs to when it is not a plain tool, for example `knowledge`. |
| `risk?` | `read`, `write` or `exec` | Risk class used by policy. Missing means `exec`. Config may add values that behave like one of these. |
| `audience?` | String | Audience a credential is needed for, when the tool calls a protected service. |
| `attrs?` | [Attrs](README.md#language) | Plain attributes a policy may read (owner, tags). Copied to `AccessQuestion.target.attrs`. |
| `ext?` | Ext | Technology-specific metadata (`mcp.annotations`, ...). |

[ToolResult](../schemas/tool-result.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | Boolean, required | False when the tool failed or was refused. Errors are results, not exceptions. |
| `text` | String, required | What the model reads. |
| `data?` | Any | Structured result. |
| `ext?` | Ext | Adapter-specific fields. |

Governed results carry `ext["sdk.outcome"]`, one of `ok`, `error`, `denied`, `blocked`, `redacted`, `pending`, so telemetry and evaluation never parse `text`. A result that waits for a human approval also carries `ext["sdk.approval"]`, the approval id.

## Semantics

- Naming: a source lists plain names. When the stack aggregates several sources it exposes each tool as `<source>__<tool>` (the separator is configurable, `__` by default), and agents' tool globs, policy rules and access questions all use these prefixed names.
- Risk: a tool without `risk` is treated as `exec`, the most dangerous class. Declare `read` only for tools that cannot change anything.
- Governed call, in order: local policy rules (first match decides: allow, ask, deny) → human approval when the effect is `ask` (without an approval port, `ask` denies; a call waits only up to the configured time and otherwise ends as pending) → authorization decision (an error denies) → guards on the arguments (`tool_args`; a redaction replaces the arguments and must stay a valid JSON object) → the tool call with bound credentials → guards on the result (`tool_result`, over `text` and over the JSON of `data`). Policy and authorization are described in [AuthorizationPort](AuthorizationPort.md) and [ApprovalPort](ApprovalPort.md); guards in [GuardPort](GuardPort.md).
- Denials and guardrail blocks are results with `ok: false`, so the model can react. They are not exceptions.
- Aborts propagate: a cancelled call rejects.
- Tokens obtained for a tool are never placed in `text`, `data`, logs or traces.
- Listing is by caller: a source may return different tools for different callers.

## Errors

- Returned as a result with `ok: false`: unknown tool name, invalid arguments, the tool failed, denial by policy, block by a guard. An adapter must not throw for an unknown tool.
- Rejects: the source is unreachable, or the call was cancelled.

## Escape hatch

`ToolSpec.ext` and `ToolResult.ext` carry technology-specific data (for example `mcp.annotations`, `mcp.content`); keys are namespaced and declared in the adapter descriptor's `ext.produces` / `ext.reads`, and the core copies them and never reads them. `ToolResult.data` carries structured output next to the text. `native()` returns the underlying client or registry. Mapping a tool standard's metadata to `risk` and `attrs` goes through the stack config `mappings` block (`tools.<name>`); see [Mappings](../language.md#mappings).

## Conformance

`checkTools` verifies:

- `listTools` returns specs that validate against `tool-spec.json`, with unique names.
- `callTool` on an unknown name returns `ok: false` instead of throwing.
- For each fixture call: the result validates against `tool-result.json`, its `text` contains the expected text, and `ok` matches the expectation.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): `ToolSpec.params` (was `inputSchema`) and `attrs`, `ext` replaces `meta`; `ToolResult {ok, text, data?}` replaces `ToolOutcome`; `CallContext.caller`
- 0.1.0 — initial

Example adapters: `functions` (maps plain functions).
