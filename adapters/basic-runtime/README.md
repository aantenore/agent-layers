# @agent-layers/adapter-basic-runtime

Maps **an in-process tool-calling loop** → **RuntimePort** (layer `harness`). Tier: prototype.

The smallest runtime that runs an agent against a composed stack: it calls the stack's model (with knowledge,
guardrails, cache and router already applied), runs the tool calls through the stack's governed tools, and repeats
until the model answers. It is meant for development, tests and demos; full runtimes plug into the same port.

Events are the core run events: `run.start`, `model.reply` (turn, model, finish, call count), `tool.call`,
`tool.result` (id, tool, `ok`, `durationMs`), `text` and `run.end` (status, reason, usage, `costUsd`), in `run` and in
`stream`. Tool calls whose arguments the model sent as unparsable text are answered with a tool error, without calling
the tool.

How a run ends:

| Cause | Status | Reason |
|---|---|---|
| Final answer | `completed` | none |
| Guard block | `stopped` | `{ code: 'guard_block', layer: 'guardrail', by: '<guard>', stage }` |
| Turn limit (`maxTurns`) | `stopped` | `{ code: 'limit', layer: 'harness', detail: 'turns' }` |
| Caller aborted / timeout | `stopped` | `{ code: 'aborted' }` / `{ code: 'timeout' }` |
| Governed call waiting for an approval (`ext["sdk.approval"]`) | `waiting` | `{ code: 'needs_input', layer: 'identity', by: '<approval instance>', detail: '<approval id>' }` |
| Any other error | `failed` | `{ code: 'error', detail: '<error name>' }` |

Reasons never carry error text. A `waiting` run has no output. Agent `settings` (`temperature`, `maxOutputTokens`, `stop`) and the agent's `ext` are passed to the
model request unchanged (keys in the model adapter's namespace, for example `openai.seed`).

The adapter reads `ext["sdk.approval"]` of governed tool results and writes no `ext` keys.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `maxTurns` | integer | `8` | Model calls per run |
| `pricing` | object | none | USD per million tokens by model id, `{ "<model>": { "inputPerMTok": 3, "outputPerMTok": 15 } }`. The run reports `costUsd` when every model call is priced; otherwise it has none |

Limits accept `${env:NAME}`. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{ "layers": { "runtime": { "adapter": "basic-runtime", "options": { "maxTurns": 6 } } } }
```
