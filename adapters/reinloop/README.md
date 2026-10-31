# @agent-layers/adapter-reinloop

Maps **[reinloop](https://github.com/aantenore/reinloop)** → **RuntimePort** (layer `harness`). Tiers: prototype,
production.

reinloop is a zero-dependency TypeScript agent runtime. This adapter binds an agent spec to a reinloop agent and lets
reinloop run the loop (turns, parallel tool batches, budgets, compaction, malformed-argument handling), while every
model and tool call goes through the stack's governed ports:

- **Model**: `stack.modelFor(agent)` wrapped as a reinloop `Provider`, so knowledge injection, input and output
  guards, cache, router and the `chat` span apply to each turn (and to the summary call of `summarize` compaction).
- **Tools**: `stack.toolsFor(agent)`, one reinloop `Tool` per tool with its name, description, schema, `risk` and
  `layer`; each call goes through policy, approval, authorization, tool guards, bound credentials and the
  `execute_tool` span.
- **Call context**: the run's `runId`, `identity`, `sessionId`, `credentials`, telemetry and abort signal reach every
  model and tool call. reinloop receives the identity without its token, for its `run_start` record only.

## What reinloop does not do here

reinloop has its own guardrails, identity verification, authorization (local policy and PDP), approvals and
knowledge retrieval. The binding configures none of them and sets reinloop's local policy to allow every call: the
stack already applies these layers once, with its own adapters and telemetry, and a second copy would ask for
approvals the stack has decided, double the latency and report decisions in two places. reinloop's run store is an
in-memory log per run; session state is the stack's `state` slot. No reinloop telemetry sink is attached, so spans are
not duplicated.

## Results and events

| reinloop | RunResult |
|---|---|
| `completed` | `completed` (reason `max_tokens` when the last answer was cut) |
| `stopped` | `stopped`, reason `budget:<limit>` (`budget:maxTurns`, `budget:maxCostUsd`, ...) or `max_tokens` |
| guardrail block (model or tool) | `stopped`, reason `guardrail:<guard>:<stage>`, empty output |
| `interrupted` (caller aborted) | `stopped`, reason `aborted` |
| `failed` | `failed`, reason from reinloop |

`usage` sums the tokens of every turn. Events are `run_start`, `model_response` (turn, model, finish reason, tool
calls, usage, `costUsd`), `tool_call`, `tool_result` (id, name, `isError`, duration), `tool_args_invalid`,
`compaction`, and `run_end` (status, reason, usage, turns, `costUsd`; with `output` when streamed). They carry no
message text, arguments or tool output. `stream` adds `text` events with the answer as it is generated (held back by
the pipeline when output guards are configured).

Telemetry the pipeline cannot see: `agent.compaction` and `agent.tool.args_invalid` events, an `agent.budget.exceeded`
event, and an `agent.cost.usd` metric when the model is priced; all carry `agent.layer` = `harness`.

Agent `params`: `temperature`, `max_tokens` and `stop` go to the model; other keys are passed as `extra`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `budget` | object | `{ maxTurns: 50 }` | `maxTurns`, `maxToolCalls`, `maxInputTokens`, `maxOutputTokens`, `maxTotalTokens`, `maxCostUsd`, `maxDurationMs` |
| `compaction` | object | none | `strategy` (`window` or `summarize`), `thresholdTokens` (required), `keepFirst`, `keepLast`, `maxTokens`, `prompt` |
| `pricing` | object | built-in table | Per model id: `inputPerMTok`, `outputPerMTok`, `cacheReadPerMTok` (USD per million tokens) |
| `tools` | object | reinloop defaults | `concurrency` (8), `timeoutMs` (none), `maxResultChars` (32000) |

```json
{
  "layers": {
    "runtime": {
      "adapter": "reinloop",
      "options": {
        "budget": { "maxTurns": 12, "maxCostUsd": 0.5 },
        "compaction": { "strategy": "window", "thresholdTokens": 24000, "keepLast": 20 }
      }
    }
  }
}
```

The dependency is `reinloop` from GitHub, pinned by commit
(`github:aantenore/reinloop#f02598b556009f7127382d930c0e44613ff062f8`) so an install never picks up code that was not
reviewed; its `prepare` script builds it on install. Once reinloop is published to npm, the pin becomes an exact
version.

## Tests

`npm test -w @agent-layers/adapter-reinloop` runs the unit tests (scripted model, function tools, the full pipeline)
and the RuntimePort conformance suite. `test/live.test.ts` runs one agent on a real model through
`openai-compatible` (`LLM_BASE_URL`, default `http://localhost:11434/v1`; `LLM_MODEL`, default `qwen3:4b`) and skips
when the endpoint or the model is not available.
