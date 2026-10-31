# @agent-layers/adapter-openai-compatible

Maps **OpenAI Chat Completions** → **ModelPort** (layer `llm`, outbound) and exposes **ChannelPort** through
**OpenAI Chat Completions** (layer `interface`, inbound). Tier: prototype, production. One package, two descriptors,
both named `openai-compatible`.

## Outbound: any compatible endpoint as the model port

Talks to any endpoint that serves `POST {baseUrl}/chat/completions`: Ollama, vLLM, LM Studio, llama.cpp, or a hosted
API. It supports plain and streamed completions, tool calls and reasoning output. Errors report the HTTP status and the
first 300 characters of the body, never the API key. `native()` returns `{ baseUrl, model }`. The active trace goes out
as `traceparent` / `tracestate`.

### Translation

Both descriptors use the same tables (`src/wire.ts`), checked by round-trip tests (wire → language → wire):

| Language | Wire | Kept / lost |
|---|---|---|
| role `system` | `system`, `developer` | `developer` (or a configured `role` alias) in: `system` with the wire role in `ext["openai.role"]`, restored out |
| `text`, `media` parts | `content` string, or items `text`, `image_url` (URL or `data:` URL), `input_audio` | other items: an `openai.part` part, passed back unchanged; `detail` in the part's `ext["openai.detail"]` |
| `call` part | `tool_calls[]` | `arguments` parsed; text that does not parse kept in `invalid` and sent back as is |
| `tool` message with `result` parts | one `role: "tool"` message per result | `ok: false` has no wire field: lost out, `true` in |
| `reasoning` part | `reasoning_content` or `reasoning` of an assistant message | not sent back unless `sendReasoning` |
| other message fields | `name`, `refusal`, ... | `ext["openai.fields"]` |
| `tools`, `toolMode` | `tools[].function`, `tool_choice` | `strict` is lost |
| `settings.temperature`, `maxOutputTokens`, `stop` | `temperature`, `max_tokens` (or `max_completion_tokens`, see `maxTokensField`), `stop` | |
| `ext["openai.<field>"]` | `response_format`, `seed`, `top_p`, `frequency_penalty`, `presence_penalty`, `logit_bias`, `user`, `parallel_tool_calls`, `reasoning_effort`, `n`, `logprobs`, `top_logprobs` | other request fields are not sent |
| `ModelReply.message`, `finish` | `choices[0]`: `stop` → `end`, `length` → `limit`, `tool_calls`/`function_call` → `tools`, `content_filter` → `refused` | `tools` exactly when there are calls; any other value `other`, the native one in `ext["openai.finish_reason"]`; other choices (`n > 1`) in `ext["openai.choices"]`; `logprobs` in `ext["openai.choice_logprobs"]` |
| `usage.inputTokens`, `outputTokens` | `prompt_tokens`, `completion_tokens` | `total_tokens` and details in `ext["openai.usage"]` |
| reply `id`, `model` | `id`, `model` | `object`, `created`, `system_fingerprint` in `ext["openai.response"]` |
| `ModelDelta` | chunk `choices[0].delta` (`content`, reasoning, `tool_calls[i]`), then one `end` | only the first choice streams; `stream_options.include_usage` asks for usage |

A stream event, or a line still waiting for its end, longer than `maxEventChars` ends the stream with an error, so a
backend cannot grow the buffer without bound.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | string | required | Endpoint root, for example `http://localhost:11434/v1` |
| `apiKey` | string | none | Sent as `Authorization: Bearer ...` when set |
| `model` | string | none | Used when the request model is `""` or `"default"` |
| `headers` | object | none | Extra request headers (string values) |
| `timeoutMs` | integer | `120000` | Timeout of a whole request, streams included |
| `includeUsage` | boolean | `true` | Ask streaming backends for a final usage chunk |
| `maxTokensField` | `max_tokens` or `max_completion_tokens` | `max_tokens` | Field that carries `settings.maxOutputTokens` |
| `sendReasoning` | boolean | `false` | Send reasoning parts of earlier assistant messages back (for backends that accept them) |
| `errorBodyChars` | integer | `300` | Characters of an error body kept in the error message |
| `streamEventChars` | integer | `100` | Characters of an invalid stream event kept in the error message |
| `maxEventChars` | integer | `1048576` | Longest stream event, or line waiting for its end, accepted from the backend |

Limits accept `${env:NAME}`; `timeoutMs` and `maxEventChars` also accept `"unbounded"`, which `agent-layers check` fails
on the production tier. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{
  "layers": {
    "model": {
      "adapter": "openai-compatible",
      "options": { "baseUrl": "http://localhost:11434/v1", "model": "qwen3:4b", "apiKey": "${LLM_API_KEY}" }
    }
  }
}
```

The live contract test (`test/live.test.ts`) runs against `LLM_BASE_URL` (default `http://localhost:11434/v1`) and
`LLM_MODEL` (default `qwen3:4b`), and skips itself when the endpoint or model is not available.

## Inbound: exposes ChannelPort through OpenAI Chat Completions

Mounted by the gateway (`agent-layers gateway`), so any runtime or SDK in any language can use the platform as its
model endpoint: `base_url = <gateway>/v1`, `api_key = <a credential the identity layer accepts>`.

- `GET /v1/models` lists the configured aliases and `agent:<name>` for each exposed agent.
- `POST /v1/chat/completions` with `model` set to:
  - **an alias** from `models`: the wire request becomes a language `ModelRequest` (same tables as above) and goes to
    the stack's governed model (input and output guards, cache, router, telemetry, token usage; no knowledge
    injection); the `ModelReply` comes back as a `chat.completion`. `tools` and tool calls pass through, so the
    caller's own agent loop keeps working. Only known request fields cross (`temperature`, `max_tokens`,
    `max_completion_tokens`, `stop`, and the passthrough fields as `ext["openai.*"]`); a caller cannot replace the
    model or the guarded messages. Role aliases and finish values added to the stack's vocabularies are resolved here.
  - **`agent:<name>`**: runs that agent through the runtime with the caller and the request's trace context, and
    returns its answer. The run id is in the `x-agent-run-id` header. `completed` ends with `finish_reason: "stop"`;
    `waiting` (the run stopped for an approval or input and can be resumed) also answers `stop`, with the output so
    far; `stopped` (a guard block, a denial) answers `content_filter` with no content, the reason staying inside;
    `failed` is HTTP 500. Streamed, `text` events become `delta.content` and `run.end` gives the finish and usage.
- `stream: true` answers with Server-Sent Events in the Chat Completions chunk format, ending with `data: [DONE]`;
  `stream_options.include_usage` adds a final usage chunk.
- Requests must be `Content-Type: application/json` (415 otherwise).
- Errors use the OpenAI error shape: 400 for an invalid body or a guard block on input (`code: "content_filter"`),
  404 `model_not_found`, 502 when the upstream model fails. Error text from upstream, and the name of the guard that
  blocked, are never returned.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `basePath` | string | `/v1` | Path prefix of the API |
| `models` | object | `{}` | Alias callers use → model id sent to the governed model |
| `agents` | boolean or string[] | `true` | Agents exposed as `agent:<name>`: all, none, or a list |
| `ownedBy` | string | `agent-layers` | `owned_by` in the model list |

```json
{
  "layers": {
    "channels": [{ "adapter": "openai-compatible", "options": { "models": { "fast": "qwen3:4b" }, "agents": ["assistant"] } }]
  }
}
```
