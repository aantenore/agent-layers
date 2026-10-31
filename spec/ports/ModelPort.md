# ModelPort

Layer: `llm` (L1 Models) · Version: 1.0.0 · Conformance: `checkModel`

## Purpose

Talk to a language model through one request/reply shape, with tool calls and optional streaming, whatever backend serves it. Guardrails, cache, router and knowledge injection wrap this port without the model adapter knowing.

## Operations

- `chat(req: ModelRequest, ctx: CallContext) → ModelReply`
  Run one model call and return the full reply.
- `stream?(req: ModelRequest, ctx: CallContext) → stream of ModelDelta`
  Optional. Same request, answered incrementally. When absent, callers fall back to `chat` and replay the reply as deltas.

`CallContext` is described in the [port index](README.md#common-types).

## Data shapes

[ModelRequest](../schemas/model-request.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `model` | String, required | Model id. A router may replace it before the call. |
| `messages` | [[Message](../schemas/message.json)], required, at least one | Conversation so far. |
| `tools?` | [ToolInfo] | Tools the model may call: `{name, description?, params}`; `params` is the JSON Schema of the arguments object. |
| `toolMode?` | `"auto"`, `"none"`, `"required"` or `{tool: String}` | How the model may use tools. Default `auto`. |
| `settings?` | `{temperature?: Number, maxOutputTokens?: Integer, stop?: [String]}` | Sampling settings. Same shape as `AgentSpec.settings`. |
| `ext?` | Ext | Backend-specific fields (`openai.response_format`, ...). |

[Message](../schemas/message.json): `role` is `system`, `user`, `assistant` or `tool` (closed; config may add aliases that adapters resolve at the edge). `parts` is always a list, never a bare string or null.

| Part | Fields | Used in |
| --- | --- | --- |
| text | `{type: "text", text}` | `system`, `user`, `assistant`. The only part the core reads. |
| media | `{type: "media", mediaType, url?, data?}` | `user`. `data` is base64. Passed through. |
| call | `{type: "call", id, tool, args, invalid?}` | `assistant`. `args` is an object; `invalid` holds the raw text when the model's arguments did not parse. |
| result | `{type: "result", callId, ok, text, data?}` | `tool`. A [tool result](ToolPort.md) answering one call. |
| reasoning | `{type: "reasoning", text}` | `assistant`. The model's reasoning when the backend returns it. Kept in history, never shown as output. |
| `<ns>.<name>` | adapter-defined | Passed through untouched, never read by the core. |

Every part and message may carry `ext?`.

[ModelReply](../schemas/model-reply.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `model` | String, required | Model that answered. |
| `message` | Message, required | Role `assistant`. One answer: there are no `choices`. |
| `finish` | String, required | Why the model stopped: `end`, `limit`, `tools`, `refused` or `other`. Config may add values that behave like one of these. |
| `usage?` | `{inputTokens, outputTokens}` | Non-negative integers. Cached or reasoning tokens go in `ext`. |
| `id?` | String | Backend response id. |
| `ext?` | Ext | Backend-specific reply fields. |

[ModelDelta](../schemas/model-delta.json), one fragment of a stream:

| Delta | Meaning |
| --- | --- |
| `{type: "text", text}` | Streamed text. |
| `{type: "reasoning", text}` | Streamed reasoning. |
| `{type: "call", index, id?, tool?, argsText?}` | Fragments of call `index`; the `argsText` fragments concatenate to the JSON arguments. |
| `{type: "end", finish, usage?, model?, id?, ext?}` | Exactly one, last. |

## Semantics

- Invariants: `system` messages hold only text parts; `tool` messages only result parts; `user` messages text and media; `assistant` messages text, reasoning and call parts.
- `finish` is `tools` exactly when the reply has at least one call part.
- Call `args` is an object. If the model's arguments are not valid JSON, the adapter sets `args` to `{}` and keeps the raw text in `invalid`.
- Assembling all deltas of a stream must give a valid `ModelReply` (the core helper `assembleDeltas` does this). Deltas are in order and the stream ends with exactly one `end`.
- `ctx.signal`: if it is already aborted, or aborts during the call, the operation rejects. It is not turned into an empty reply.
- Only `text` parts are interpreted by the stack; media and namespaced parts pass through untouched.
- Usage is reported when the backend reports it; cost and token metrics are derived from it.
- The stack may wrap a model with input guards, a cache, a router and output guards (see [Composition](README.md#composition)). A guard block surfaces as a guardrail error raised by the wrapped model; the adapter never sees it. Streaming with output guards is buffered, because the whole text is needed before it can be released.

## Errors

- Rejects: backend failure, authentication failure, timeout, cancellation, guardrail block (from the wrapper).
- Returns as a result: a refusal or content filter outcome is a normal reply with `finish: "refused"`. A finish value the adapter does not know becomes `other`, with the native value in `ext`.

## Escape hatch

- `ext` on the request carries backend-specific settings (for example `openai.response_format`) and `ext` on the reply carries backend fields the contract does not model. Keys are namespaced (`<namespace>.<name>`) and declared in the adapter descriptor's `ext.produces` / `ext.reads`; the core copies them and never reads them.
- Parts of a namespaced type pass through.
- `native()` returns the backend client.
- Boundary mappings for the backend's wire format go through the `mappings` block of the stack config; see [Mappings](../language.md#mappings).

## Conformance

`checkModel` verifies:

- `chat` resolves to a reply that validates against `model-reply.json`, has text or call parts, and has `finish: "tools"` exactly when it has call parts.
- When `stream` exists: it yields at least one delta, and the deltas assemble to a valid reply. Otherwise this check is skipped.
- When the tool-call fixture is on: with `toolMode: "required"` the model returns a call part for the offered tool, with `args` an object.
- Unless disabled: `chat` with an already aborted signal rejects.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): `ModelRequest`, `ModelReply`, `ModelDelta`; messages are lists of typed parts (text, media, call, result, reasoning); `toolMode`, `settings` and `ext` replace `tool_choice`, flat sampling fields and `extra`; one answer per call (no `choices`); finish values `end`, `limit`, `tools`, `refused`, `other`; usage as `inputTokens` / `outputTokens`
- 0.1.0 — initial

Example adapters: `openai-compatible` (translates the OpenAI Chat Completions format), `mock-model` (scripted deterministic model for tests).
