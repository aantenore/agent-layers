# Cost

Cross-cutting. Not a layer: cost is controlled in the model gateway, measured in telemetry and bounded in the
runtime. Overview in [stack.md](../stack.md).

## Controls

| Control | What it does | Layer |
|---|---|---|
| Per-run budgets | Cap tokens, tool calls or spend for one run; the run stops with a clear status when exceeded | [L2](../layers/L2-harness.md) |
| Gateway quotas | Rate and spend limits per key, team or agent | [L7](../layers/L7-cache-router.md) |
| Exact-match cache | Repeated identical requests are served without a model call | L7 |
| Routing | Cheaper model for easy requests, stronger model for hard ones; fallbacks on failure | L7 |
| Local models | The reference setup runs on Ollama with `qwen3:4b`, at no per-token cost | [L1](../layers/L1-llm.md) |

## Measurement

[L8](../layers/L8-telemetry.md) records what was spent:

- `gen_ai.client.token.usage`: input and output tokens per call.
- `agent.cost.usd`: cost per run and per model.
- `agent.tool.calls`: tool volume, since tool calls often drive further model calls.

Dashboards and alerts on these metrics tell you which agent, model or tool is expensive. Every run also ends with
`usage` and `costUsd` in its `run_end` event, so cost is available without a tracing backend.

## Practices

- Set a budget in every agent file before it leaves design; see [lifecycle](../lifecycle.md).
- Put quotas at the gateway, not only in the agent: a misbehaving agent cannot lift a limit it does not control.
- Evaluate cheaper models and routes with `reinloop replay` over stored runs before switching (L9), so a saving
  does not silently cost quality.
- Watch cache hit rate and stale hits; semantic caching is deliberately not part of the agent loop.
