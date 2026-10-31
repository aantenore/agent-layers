# Cache (model access) reference setup

Response cache and model routing. Layer page: [docs/layers/cache.md](../../docs/layers/cache.md).

| Path | Content |
|---|---|
| `compose.yml` | LiteLLM proxy and Valkey; the LiteLLM config is inlined under `configs.litellm_config.content` |
| `test/gateway.test.mjs` | Live test against the gateway |

## Standard and extension points

- Standard: an OpenAI-compatible gateway. Any gateway that speaks Chat Completions replaces LiteLLM.
- Extension points: `CachePort` for the response cache, `RouterPort` for in-process routing.
- Reference: [LiteLLM](https://github.com/BerriAI/litellm) proxy (MIT) with [Valkey](https://valkey.io) (BSD-3-Clause)
  as the Redis-protocol cache. In process: the `memory-cache` adapter and the `rule-router` / `static-router` adapters.

## Contract

| Variable | Default |
|---|---|
| `GATEWAY_URL` | `http://localhost:4000/v1` |
| `GATEWAY_KEY` | `sk-local-change-me` (also the LiteLLM master key) |
| `VALKEY_URL` | `redis://localhost:6379` |

Model groups exposed by the gateway:

| Group | Behavior |
|---|---|
| `default` | `ollama_chat/qwen3:4b` on the host Ollama (`host.docker.internal:11434`) |
| `fast` | `ollama_chat/lfm2.5:8b` on the host Ollama: faster, with tool calling (needs `ollama pull lfm2.5:8b`) |
| `hosted` | Optional: the model named by `HOSTED_MODEL` with `HOSTED_API_KEY` (any provider LiteLLM supports, set in `.env`), with a LiteLLM deployment budget of 1 USD per 30 days (`HOSTED_MAX_BUDGET_USD`, `HOSTED_BUDGET_DURATION`). Without them the group has no deployment and requests to it fail |
| `fallback-test` | Primary is a model that does not exist; every request falls back to `default` |

Change the model by editing `ollama_chat/qwen3:4b` in the inlined config. The config is inlined (and not a bind
mount) so the file keeps working when layer compose files are merged with several `-f` options.

Cache: exact match on the whole request, 10 minutes TTL, stored in Valkey. A cache hit carries the response header
`x-litellm-cache-key` (a miss does not) and replays the stored response, including its `id`. A request that falls
back carries `x-litellm-attempted-fallbacks: 1`.

## Run

```bash
make up LAYER=cache      # LiteLLM needs about a minute to become healthy
make down LAYER=cache    # Valkey keeps no data on disk
```

Use the gateway as the model of a stack with the `openai-compatible` adapter:

```json
{
  "layers": {
    "model": { "adapter": "openai-compatible", "options": { "baseUrl": "${env:GATEWAY_URL}", "apiKey": "${env:GATEWAY_KEY}" } }
  },
  "agents": { "assistant": { "model": "default" } }
}
```

In-process routing with the `rule-router` adapter (works with models from different providers):

```json
{
  "layers": {
    "router": { "adapter": "rule-router", "options": { "rules": [{ "when": { "minEstTokens": 6000 }, "model": "large" }], "default": "main" } }
  }
}
```

## Swap

- Gateway: any OpenAI-compatible gateway on `GATEWAY_URL` (Portkey, Helicone, OpenRouter, a custom proxy).
- Cache store: another Redis-protocol server (Redis, KeyDB) in place of Valkey, or the in-process stores.
- Router: implement `RouterPort` or use `rule-router`; or use gateway model groups and fallbacks.

## Test

```bash
make test LAYER=cache
```

It needs the stack above and the host Ollama, and skips with a message otherwise. It composes stacks with
`compose(resolveProfile(config), { adapters })` and checks that an agent completes through the gateway (`openai-compatible`
model, `basic-runtime`), that an identical second request is a cache hit, that `fallback-test` is answered by its
fallback, and that the `rule-router` adapter picks the expected model (read from the router telemetry span and the
`model.reply` events). Requests are not repeated beyond that.
