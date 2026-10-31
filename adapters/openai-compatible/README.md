# @agent-layers/adapter-openai-compatible

Maps **OpenAI Chat Completions** → **ModelPort** (layer `llm`). Tier: prototype, production.

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
