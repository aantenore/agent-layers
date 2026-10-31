# @agent-layers/adapter-mock-model

Maps **scripted deterministic model** → **ModelPort** (layer `llm`). Tier: prototype.

An offline model for development and tests: no network, no randomness. It answers in this order: a tool result
becomes the final answer; the first matching rule replies or calls a tool; a forced `tool_choice` calls the first (or
named) tool with `{}`; retrieved knowledge passages are answered with the first passage; anything else is echoed as
`You said: <message>`. A rule that matches but can neither call an offered tool nor reply is skipped. Streaming splits
the answer into word chunks. Token usage is estimated at four characters per token.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `model` | string | `mock` | Model id reported in responses |
| `rules` | object[] | `[]` | `{ match, tool?, args?, reply? }`: `match` is a case-insensitive regex tested on the last user message; `tool` matches an offered function by full name or by the part after the last `__`; `args` and `reply` may use `{{1}}`, `{{2}}` for capture groups |
| `latencyMs` | integer | `0` | Delay before each answer |

```json
{
  "layers": {
    "model": {
      "adapter": "mock-model",
      "options": {
        "rules": [
          { "match": "weather in (\\w+)", "tool": "forecast", "args": { "city": "{{1}}" } },
          { "match": "^hello", "reply": "Hi there." }
        ]
      }
    }
  }
}
```
