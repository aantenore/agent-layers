# Cost

Cross-cutting. Not a layer: cost is controlled in the model gateway, measured in telemetry and bounded in the
runtime. Overview in [stack.md](../stack.md).

## Controls

| Control | What it does | Layer |
|---|---|---|
| Per-run budgets | Cap tokens, tool calls or spend for one run; the run stops with a clear status when exceeded | [harness](../layers/harness.md) |
| Gateway quotas | Rate and spend limits per key, team or agent | [cache](../layers/cache.md) |
| Exact-match cache | Repeated identical requests are served without a model call | [cache](../layers/cache.md) |
| Routing | Cheaper model for easy requests, stronger model for hard ones; fallbacks on failure | [cache](../layers/cache.md) |
| Local models | The reference setup runs on Ollama with `qwen3:4b`, at no per-token cost | [llm](../layers/llm.md) |

## Measurement

[telemetry](../layers/telemetry.md) records what was spent:

- `agent.model.tokens`: tokens per call, split by `agent.tokens.kind` (`input` or `output`); the `usage` of a reply
  is `{ inputTokens, outputTokens }`. The `otlp` adapter writes the same numbers as `gen_ai.client.token.usage` for
  dashboards that expect it.
- `costUsd` on the run result and its `run.end` event: cost per run.
- `agent.tool.calls`: tool volume, since tool calls often drive further model calls.

Dashboards and alerts on these metrics tell you which agent, model or tool is expensive. Every run also ends with
`usage` and `costUsd` in its `run.end` event, so cost is available without a tracing backend.

## Practices

- Set a budget in every agent file before it leaves design; see [lifecycle](../lifecycle.md).
- Put quotas at the gateway, not only in the agent: a misbehaving agent cannot lift a limit it does not control.
- Evaluate cheaper models and routes by replaying stored runs before switching ([eval](../layers/eval.md)), so a saving
  does not silently cost quality.
- Watch cache hit rate and stale hits; semantic caching is deliberately not part of the agent loop.
