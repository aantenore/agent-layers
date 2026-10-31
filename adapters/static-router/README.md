# @agent-layers/adapter-static-router

Maps **static model mapping** → **RouterPort** (layer `cache`). Tier: prototype, production.

Chooses the model for each request from fixed configuration, without calling anything. The first match wins: the
agent's model, then the alias for the requested model, then the default `model`, then the requested model unchanged.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `model` | string | none | Model used when no agent or alias rule applies |
| `agents` | object | `{}` | Agent name → model |
| `aliases` | object | `{}` | Requested model → model |

```json
{
  "layers": {
    "router": {
      "adapter": "static-router",
      "options": { "model": "gpt-4o-mini", "agents": { "support": "gpt-4o" }, "aliases": { "fast": "gpt-4o-mini" } }
    }
  }
}
```
