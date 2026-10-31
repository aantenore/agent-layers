# L2 Model access: routing, fallback, quotas, cache (`cache`)

## Responsibility

Reduce cost and latency and choose the model per request: exact-match caching, routing between model groups,
fallbacks and quotas.

## Standard

An OpenAI-compatible gateway. The agent sees an ordinary [llm](llm.md) endpoint.

## Extension point

- `CacheStore.get/set`: backend for the reinloop response cache.
- `ModelRouter.select(req) → model`: per-request model choice inside the runtime.

## Reference implementation

| Role | Reference | License |
|---|---|---|
| Gateway | LiteLLM proxy (model groups, fallbacks, exact cache) | MIT core; `enterprise/` excluded |
| Cache store | Valkey | BSD-3-Clause |
| In process | reinloop memory / file response cache | MIT |

Only the MIT-licensed parts of LiteLLM are used.

## Adapter SDK + conformance

`ModelRouter`. A conformance check feeds fixed requests and verifies that `select` returns a model from the
configured set and is deterministic for the same input. Gateways need no SDK: the OpenAI-compatible API is the
standard.

## Around the layer

- **In-process rule router.** A rule-based `ModelRouter` (for example by prompt size or agent) that works without a
  gateway.
- **Fallbacks.** If a model fails, the next one in the group is tried.
- **Quotas.** Rate and spend limits per key; see [cost](../cross-cutting/cost.md).

Semantic caching is deliberately not part of the agent loop; exact-match caching is safe for tests and repeated
identical requests.

## How to swap it

- Any OpenAI-compatible gateway (Portkey, Helicone, Envoy AI Gateway, a plain reverse proxy) replaces LiteLLM:
  set `GATEWAY_URL` and `GATEWAY_KEY`.
- Any Redis-protocol store replaces Valkey.
- A custom cache implements `CacheStore`; a custom routing policy implements `ModelRouter`.

## Contract

- Gateway: transparent OpenAI-compatible endpoint at `GATEWAY_URL`.
- In process: `responseCache` over a `CacheStore`; `ModelRouter.select(req)` returns the model to use.

Details in the port spec: [CachePort](../../spec/ports/CachePort.md) and [RouterPort](../../spec/ports/RouterPort.md).

## How to test

```bash
make up LAYER=l7-cache-router
make test LAYER=l7-cache-router
make down LAYER=l7-cache-router
```

The test sends the same request twice through the gateway and checks the second one is a cache hit.
Variables: `GATEWAY_URL`, `GATEWAY_KEY`, `VALKEY_URL`.
