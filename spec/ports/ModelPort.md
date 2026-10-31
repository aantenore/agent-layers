# ModelPort

Layer: `llm` (L1 Models) · Version: 0.1.0 · Conformance: `checkModel`

## Purpose

Talk to a language model through one request/response shape, with tool calls and optional streaming, whatever backend serves it. Guardrails, cache, router and knowledge injection wrap this port without the model adapter knowing.

## Operations

- `chat(req: ChatRequest, ctx: CallContext) → ChatResponse`
  Run one chat completion and return the full response.
- `stream?(req: ChatRequest, ctx: CallContext) → stream of ChatChunk`
  Optional. Same request, answered incrementally. When absent, callers fall back to `chat` and replay the response as chunks.

`CallContext` is described in the [port index](README.md#common-types).

## Data shapes

[ChatRequest](../schemas/chat-request.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `model` | String, required | Model id. A router may replace it before the call. |
| `messages` | [Message], required | Conversation so far. |
| `tools?` | [{`type`: "function", `function`: {`name`, `description?`, `parameters?`}}] | Tools the model may call; `parameters` is a schema of the arguments. |
| `tool_choice?` | `"auto"`, `"none"`, `"required"` or `{type: "function", function: {name}}` | How the model may use tools. |
| `temperature?` | Number | Sampling temperature. |
| `max_tokens?` | Integer | Output limit. |
| `stop?` | [String] | Stop sequences. |
| `extra?` | {String: Any} | Backend-specific fields, passed through. |

Message roles: `system`, `developer`, `user`, `assistant`, `tool`. `content` is a string or a list of parts (`{type: "text", text}` or other parts the core does not interpret). An `assistant` message may have `content: null` and `tool_calls`. A `tool` message carries `tool_call_id`.

[ChatResponse](../schemas/chat-response.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `id?` | String | Backend response id. |
| `model` | String, required | Model that answered. |
| `choices` | [Choice], required, at least one | `index`, `message` (`role: "assistant"`, `content: String?`, `tool_calls?`), `finish_reason: String?`. |
| `usage?` | {`prompt_tokens`, `completion_tokens`, `total_tokens?`} | Non-negative integers. |
| `extra?` | {String: Any} | Backend-specific response fields. |

A tool call is `{id, type: "function", function: {name, arguments}}` where `arguments` is a JSON-encoded string. Common finish reasons: `stop`, `length`, `tool_calls`, `content_filter`; others are allowed.

`ChatChunk`: `id?`, `model?`, `choices: [{index, delta: {role?, content?, tool_calls?: [{index, id?, type?, function?: {name?, arguments?}}]}, finish_reason?}]`, `usage?`. Tool-call deltas with the same `index` are concatenated.

## Semantics

- A response has either `content` text or `tool_calls` in its first choice.
- Tool-call `arguments` must be a valid JSON string.
- Assembling all chunks of a stream must give a valid `ChatResponse`. Chunks are in order; every chunk has a `choices` array.
- `ctx.signal`: if it is already aborted, or aborts during the call, the operation rejects. It is not turned into an empty response.
- Only `text` parts of content are interpreted by the stack; other parts pass through untouched.
- Usage is reported when the backend reports it; cost and token metrics are derived from it.
- The stack may wrap a model with input guards, a cache, a router and output guards (see [Composition](README.md#composition)). A guard block surfaces as a guardrail error raised by the wrapped model; the adapter never sees it. Streaming with output guards is buffered, because the whole text is needed before it can be released.

## Errors

- Rejects: backend failure, authentication failure, timeout, cancellation, guardrail block (from the wrapper).
- Returns as a result: a refusal or content filter outcome is a normal response with the matching `finish_reason`.

## Escape hatch

- `extra` on the request is merged into the backend request body unchanged; `extra` on the response carries backend fields the contract does not model.
- Content parts of unknown `type` pass through.
- `native()` returns the backend client.

## Conformance

`checkModel` verifies:

- `chat` resolves to a response that validates against `chat-response.json`, and its first choice has content or tool calls.
- When `stream` exists: it yields at least one chunk, every chunk has a `choices` array, and the assembled stream validates as a response. Otherwise this check is skipped.
- When the tool-call fixture is on: with `tool_choice: required` the model returns the offered tool by name, with arguments that are valid JSON.
- Unless disabled: `chat` with an already aborted signal rejects.

## Version history

- 0.1.0 — initial

Example adapters: `openai-compatible` (maps the OpenAI Chat Completions format), `mock-model` (scripted deterministic model for tests).
