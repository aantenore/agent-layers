# @agent-layers/adapter-basic-runtime

Maps **an in-process tool-calling loop** → **RuntimePort** (layer `harness`). Tier: prototype.

The smallest runtime that runs an agent against a composed stack: it calls the stack's model (with knowledge,
guardrails, cache and router already applied), runs the tool calls through the stack's governed tools, and repeats
until the model answers. It is meant for development, tests and demos; full runtimes plug into the same port.

A guardrail block ends the run with status `stopped` and reason `guardrail:<guard>:<stage>`; the turn limit ends it
with reason `max_turns`. Agent `params` such as `temperature` and `max_tokens` go to the model; other params are
passed as `extra`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `maxTurns` | integer | `8` | Model calls per run |
| `pricing` | object | none | USD per million tokens by model id, `{ "<model>": { "inputPerMTok": 3, "outputPerMTok": 15 } }`. The run reports `costUsd` when every model call is priced; otherwise it has none |

Limits accept `${env:NAME}`. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{ "layers": { "runtime": { "adapter": "basic-runtime", "options": { "maxTurns": 6 } } } }
```
