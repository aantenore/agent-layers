# Cache (model access) reference setup

Response cache and model routing. Layer page: [docs/layers/cache.md](../../docs/layers/cache.md).

| Path | Content |
|---|---|
| `compose.yml` | LiteLLM proxy and Valkey; the LiteLLM config is inlined under `configs.litellm_config.content` |
| `test/gateway.test.mjs` | Live test against the gateway |

## Standard and extension points

- Standard: an OpenAI-compatible gateway. Any gateway that speaks Chat Completions replaces LiteLLM.
- Extension points (reinloop): `CacheStore` for the response cache, `ModelRouter` for in-process routing.
- Reference: [LiteLLM](https://github.com/BerriAI/litellm) proxy (MIT) with [Valkey](https://valkey.io) (BSD-3-Clause)
  as the Redis-protocol cache. In process: reinloop `memory` / `file` response caches and `ruleRouter`.

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
| `hosted` | Optional: the model named by `HOSTED_MODEL` with `HOSTED_API_KEY` (any provider LiteLLM supports, set in `.env`), with a LiteLLM deployment budget of 1 USD per 30 days. Without them the group has no deployment and requests to it fail |
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

Use it from reinloop as an OpenAI-compatible provider:

```json
{
  "providers": { "gateway": { "type": "openai-compatible", "baseUrl": "${env:GATEWAY_URL}", "apiKey": "${env:GATEWAY_KEY}" } },
  "models": { "main": { "provider": "gateway", "model": "default" } },
  "agents": { "assistant": { "model": "main" } }
}
```

In-process routing with a rule router (works with models from different providers):

```json
{
  "routers": { "by-size": { "type": "rule", "rules": [{ "when": { "minEstTokens": 6000 }, "model": "large" }], "default": "main" } },
  "agents": { "assistant": { "model": "main", "router": "by-size" } }
}
```

## Swap

- Gateway: any OpenAI-compatible gateway on `GATEWAY_URL` (Portkey, Helicone, OpenRouter, a custom proxy).
- Cache store: another Redis-protocol server (Redis, KeyDB) in place of Valkey, or the in-process stores.
- Router: implement `ModelRouter` or use `ruleRouter`; or use gateway model groups and fallbacks.

## Test

```bash
make test LAYER=cache
# against a local reinloop checkout
REINLOOP_SRC=/path/to/reinloop/src/index.ts make test LAYER=cache
```

It needs the stack above and the host Ollama, and skips with a message otherwise. It checks that a reinloop agent
completes through the gateway, that an identical second request is a cache hit, that `fallback-test` is answered by
its fallback, and that `ruleRouter` picks the expected model (read from the `model_request` / `model_response`
events). Requests are not repeated beyond that.
