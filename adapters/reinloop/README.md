# @agent-layers/adapter-reinloop

Maps **[reinloop](https://github.com/aantenore/reinloop)** → **RuntimePort** (layer `harness`). Tiers: prototype,
production.

reinloop is a zero-dependency TypeScript agent runtime. This adapter binds an agent spec to a reinloop agent and lets
reinloop run the loop (turns, parallel tool batches, budgets, compaction, malformed-argument handling), while every
model and tool call goes through the stack's governed ports:

- **Model**: `stack.modelFor(agent)` wrapped as a reinloop `Provider`, so knowledge injection, input and output
  guards, cache, router and the `agent.model.call` span apply to each turn (and to the summary call of `summarize`
  compaction). reinloop messages and parts map one to one to the language's `Message` and `Part`: `thinking` is a
  `reasoning` part, `tool_call` a `call` part, `tool_result` a `result` part (`isError` is `ok: false`); stop reasons
  map to `finish` (`end`, `tool_calls` is `tools`, `max_tokens` is `limit`, `refusal` is `refused`). Media parts and
  reinloop's hosted-tool parts have no counterpart and are left out.
- **Tools**: `stack.toolsFor(agent)`, one reinloop `Tool` per tool with its name, description, schema, `risk` and
  `layer`; each call goes through policy, approval, authorization, tool guards, bound credentials and the
  `agent.tool.call` span.
- **Call context**: the run's `runId`, `caller`, `sessionId`, `credentials`, telemetry and abort signal reach every
  model and tool call. reinloop receives the caller without its credential (`publicCaller`), for its `run_start`
  record only.

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
| `completed` | `completed`; when the last answer was cut, reason `{ code: 'limit', layer: 'harness', by: 'reinloop', detail: 'max_tokens' }` |
| `stopped` by a budget | `stopped`, reason `{ code: 'limit', layer: 'harness', by: 'reinloop', detail: '<limit>' }` (`maxTurns`, `maxCostUsd`, ...) |
| `stopped` at `max_tokens` without an answer | `stopped`, reason as above with `detail: 'max_tokens'` |
| guard block (model or tool) | `stopped`, the guard's stop reason (`guard_block`, `by` the guard, `stage`), empty output |
| governed call waiting for an approval (`ext["sdk.approval"]`) | `waiting`, reason `{ code: 'needs_input', layer: 'identity', by: '<approval instance>', detail: '<approval id>' }`, empty output |
| `interrupted` (caller aborted) | `stopped`, reason `{ code: 'aborted' }`, or `{ code: 'timeout' }` when the signal expired |
| `failed` | `failed`, reason from the error the model raised (`stopReasonOf`: `error` with the error name as `detail`), else `{ code: 'error', layer: 'harness', by: 'reinloop' }` |

Reasons never carry error text. `usage` sums the tokens of every turn; `costUsd` on the result is the run's cost from
reinloop's price table and `pricing`.

Events are the core run events, in `run` and in `stream`: `run.start`, `model.reply` (turn, model, finish, call
count), `tool.call`, `tool.result` (id, tool, `ok`, duration), `text` and `run.end` (status, reason, usage,
`costUsd`). The adapter adds its own: `reinloop.usage` (turn, tokens and `costUsd` of that model call),
`reinloop.compaction` (strategy, tokens before and after) and `reinloop.args_invalid` (id, tool, `repaired`). They carry
no message text, arguments or tool output. `stream` adds `text` events with the answer as it is generated (held back
by the pipeline when output guards are configured).

Telemetry the pipeline cannot see: `reinloop.compaction` and `reinloop.args_invalid` events, a
`reinloop.budget.exceeded` event, and a `reinloop.cost.usd` metric when the model is priced; all carry `agent.layer` =
`harness` and `agent.name`, and their own attributes are in the `reinloop.` namespace. The adapter opens no model or
tool spans of its own: the stack's `agent.model.call` and `agent.tool.call` already cover each call.

`ext`: the adapter reads `ext["sdk.approval"]` of governed tool results and writes no `ext` keys.

Agent settings: `settings.temperature`, `settings.maxOutputTokens` and `settings.stop` go to the model.
`ext["reinloop.retryMaxTokens"]` (number) makes reinloop repeat an answer cut at the token limit once with that limit.
Other `ext` keys of the agent (those of the model adapter's namespace, for example `openai.seed`) are sent with every
model request.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `budget` | object | `{ maxTurns: 50 }` | `maxTurns`, `maxToolCalls`, `maxInputTokens`, `maxOutputTokens`, `maxTotalTokens`, `maxCostUsd`, `maxDurationMs`; the ones not listed have no limit |
| `compaction` | object | none | `strategy` (`window` or `summarize`), `thresholdTokens` (required), `keepFirst`, `keepLast`, `maxTokens`, `prompt` |
| `pricing` | object | built-in table | Per model id: `inputPerMTok`, `outputPerMTok`, `cacheReadPerMTok` (USD per million tokens) |
| `tools` | object | reinloop defaults | `concurrency` (8), `timeoutMs` (none), `maxResultChars` (32000) |

Limits accept `${env:NAME}`. The budgets, `tools.timeoutMs` and `tools.maxResultChars` also accept `"unbounded"`;
`agent-layers check` fails it for `maxTurns` and `tools.maxResultChars` on the production tier and warns for the
others. Without `budget`, reinloop's default `{ maxTurns: 50 }` applies; a `budget` limits only what it lists. Ranges and checks: [docs/limits.md](../../docs/limits.md).

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
(`github:aantenore/reinloop#d3b0396649d117ad0ef8ff07bd2887b2660ab48e`) so an install never picks up code that was not
reviewed; its `prepare` script builds it on install. Once reinloop is published to npm, the pin becomes an exact
version.

## Tests

`npm test -w @agent-layers/adapter-reinloop` runs the unit tests (scripted model, function tools, the full pipeline,
mapping of messages and events) and the RuntimePort conformance suite. `test/live.test.ts` runs one agent on a real model through
`openai-compatible` (`LLM_BASE_URL`, default `http://localhost:11434/v1`; `LLM_MODEL`, default `qwen3:4b`) and skips
when the endpoint or the model is not available.
