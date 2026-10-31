# @agent-layers/adapter-rule-router

Maps **local routing rules** → **RouterPort** (layer `cache`). Tiers: prototype, production. Maturity: experimental.

Picks the model from ordered rules on the request: its estimated size, whether it offers tools, and how far the
conversation has gone. The first rule whose conditions all hold wins; otherwise `default`, otherwise the model the
request asked for. It makes no calls and costs nothing, so short questions can go to a small model and long contexts or
tool use to a larger one.

It complements `static-router`, which maps by agent name and alias; the two decide on different inputs. Use one router
per stack.

Conditions (all that are set must hold):

- `minEstTokens`, `maxEstTokens`: estimated tokens of the request, about 4 characters each over messages, tool calls and
  tool definitions. Inclusive.
- `hasTools`: the request offers tools (`tool_choice: "none"` counts as none).
- `turnAtLeast`: turn N follows N-1 assistant messages, so a first request is turn 1.

A rule needs at least one condition; use `default` for the catch-all.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `rules` | `{ when, model }[]` | required | Checked in order |
| `default` | string | the requested model | Model when no rule matches |

```json
{
  "layers": {
    "router": {
      "adapter": "rule-router",
      "options": {
        "rules": [
          { "when": { "minEstTokens": 6000 }, "model": "gpt-4o" },
          { "when": { "hasTools": true }, "model": "gpt-4o" },
          { "when": { "maxEstTokens": 400, "hasTools": false }, "model": "gpt-4o-mini" }
        ],
        "default": "gpt-4o-mini"
      }
    }
  }
}
```
