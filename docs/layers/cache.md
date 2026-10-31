# Model access

Layer id `cache` (L2), Model plane. *Which model, at what cost and latency?*

## Responsibility

Reduce cost and latency and choose the model per request: exact-match caching, routing between models, fallbacks and
quotas. The agent sees an ordinary [llm](llm.md) endpoint.

## Ports

| Port | What it does |
|---|---|
| [RouterPort](../../spec/ports/RouterPort.md) | `select` picks the model for a `ModelRequest` |
| [CachePort](../../spec/ports/CachePort.md) | `get` / `set` / `delete` with a TTL; usable by any layer (tool results, embeddings, retrieval); model-reply keys are computed over the `ModelRequest` |

### Where it sits

```mermaid
flowchart LR
  harness["L3 harness<br/>model calls"]:::agent --> cachep
  other["L4 knowledge, L5 tool<br/>optional use"]:::agent -.-> cachep
  subgraph sg["L2 cache"]
    cachep["CachePort<br/>get, set, delete with TTL"]:::model
    router["RouterPort<br/>select the model"]:::model
  end
  harness --> router
  cachep --> store["memory-cache<br/>valkey (planned)"]:::external
  router --> llm["L1 llm<br/>via a gateway: quotas, fallback"]:::model
  classDef model fill:#ffd8a8,stroke:#a85400,color:#1f2328
  classDef agent fill:#a5d8ff,stroke:#1864ab,color:#1f2328
  classDef external fill:#ffffff,stroke:#57606a,color:#1f2328,stroke-dasharray:4 3
```

## Standards

An OpenAI-compatible gateway is the standard way to provide routing, fallback and quotas outside the process. Cache
stores that speak the Redis protocol are interchangeable.

## Decision flow

A hit skips the router and the model. Quotas and fallback live in the gateway behind the model.

```mermaid
flowchart TB
  req["ModelRequest<br/>already input-guarded"]:::external --> lookup{"CachePort.get<br/>hit?"}:::model
  lookup -->|"hit"| out["Output guards, then the answer"]:::control
  lookup -->|"miss"| select["RouterPort.select<br/>pick the model id"]:::model
  select --> model["ModelPort.chat<br/>gateway: quotas, fallback group"]:::model
  model --> store["CachePort.set<br/>raw ModelReply, TTL"]:::model
  store --> out
  classDef model fill:#ffd8a8,stroke:#a85400,color:#1f2328
  classDef control fill:#ffc9c9,stroke:#b42318,color:#1f2328
  classDef external fill:#ffffff,stroke:#57606a,color:#1f2328,stroke-dasharray:4 3
```

## Boundaries

- Output guards also run on cached answers: the cache stores the raw model reply, see [architecture](../architecture.md#composition-pipelines).
- Semantic caching is deliberately not part of the agent loop; exact-match caching is safe for tests and repeated
  identical requests.
- Rate and spend limits per key are quotas; see [cost](../cross-cutting/cost.md).

## How to swap

- A gateway replaces or complements the in-process router: set the `openai-compatible` adapter's base URL to it.
- Any Redis-protocol store replaces Valkey; a custom cache implements CachePort.
- A custom routing policy implements RouterPort.

## Reference adapters

| Adapter | Maps |
|---|---|
| `static-router` | A static model mapping |
| `rule-router` | Rule-based choice, for example by prompt size or agent |
| `memory-cache` | An in-process map (prototype) |

A model gateway sits behind `openai-compatible`. Full list: [adapters.md](../adapters.md).

## Reference setup

[`reference/cache/`](../../reference/cache/README.md) runs the LiteLLM proxy (MIT core; the `enterprise/` directory is
under a separate commercial license and is not used) with Valkey (BSD-3-Clause) as the cache. The gateway exposes model
groups, a fallback group and an exact-match cache. Variables: `GATEWAY_URL`, `GATEWAY_KEY`, `VALKEY_URL`.

```bash
make up LAYER=cache
make test LAYER=cache
make down LAYER=cache
```

The test sends the same request twice through the gateway and checks that the second is a cache hit.
