# @agent-layers/adapter-openai-compatible

Maps **OpenAI Chat Completions** → **ModelPort** (layer `llm`, outbound) and exposes **ChannelPort** through
**OpenAI Chat Completions** (layer `interface`, inbound). Tier: prototype, production. One package, two descriptors,
both named `openai-compatible`.

## Outbound: any compatible endpoint as the model port

Talks to any endpoint that serves `POST {baseUrl}/chat/completions`: Ollama, vLLM, LM Studio, llama.cpp, or a hosted
API. It supports plain and streamed completions, tool calls and `extra` request fields. Errors report the HTTP status
and the first 300 characters of the body, never the API key. `native()` returns `{ baseUrl, model }`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | string | required | Endpoint root, for example `http://localhost:11434/v1` |
| `apiKey` | string | none | Sent as `Authorization: Bearer ...` when set |
| `model` | string | none | Used when the request model is `""` or `"default"` |
| `headers` | object | none | Extra request headers (string values) |
| `timeoutMs` | integer | `120000` | Timeout of a whole request, streams included |
| `includeUsage` | boolean | `true` | Ask streaming backends for a final usage chunk |

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
  - **an alias** from `models`: the request goes to the stack's governed model (input and output guards, cache,
    router, telemetry, token usage; no knowledge injection). `tools` and `tool_calls` pass through, so the caller's own
    agent loop keeps working. Only known request fields are forwarded (`temperature`, `max_tokens`, `stop`,
    `response_format`, `seed`, `top_p`, ...); a caller cannot replace the model or the guarded messages.
  - **`agent:<name>`**: runs that agent through the runtime with the caller's identity and returns its final
    answer. The run id is in the `x-agent-run-id` header. A run stopped by a guard ends with `finish_reason:
    "content_filter"`.
- `stream: true` answers with Server-Sent Events in the Chat Completions chunk format, ending with `data: [DONE]`;
  `stream_options.include_usage` adds a final usage chunk.
- Errors use the OpenAI error shape: 400 for an invalid body or a guard block on input (`code: "content_filter"`),
  404 `model_not_found`, 502 when the upstream model fails. Error text from upstream is never returned.

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
