# @agent-layers/adapter-layer-signals

Maps **per-layer signals from run events and telemetry** → **EvaluatorPort** (layer `eval`). Tiers: prototype,
production. Maturity: experimental.

Turns a run into one health score per layer, so a failing case points at the layer to fix. Each score is
`<layer>_health` (1 = healthy, 0 = failed), carries the `layer`, and has a reason with counts and names, never content.
A layer without any signal gets no score. Nothing is read from text: stop reasons, run events and telemetry attributes
are structured values.

| Layer | Signal | Score |
|---|---|---|
| `guardrail` | `agent.guard.check` spans (`agent.guard.action`); a run stopped with reason code `guard_block` (the reason names the guard and the stage) | 0 if anything was blocked, 0.5 if only redacted, else 1 |
| `identity` | `agent.access.check` spans (`agent.access.decision`) | 1 - denied / decisions; a denial that is a call waiting for an approval (`agent.tool.outcome` `pending`) is not counted |
| `tool` | `agent.tool.call` spans (`agent.tool.outcome` `error`), else `tool.result` events with `ok: false` | 1 - failed / calls; denied, blocked and pending calls belong to identity and guardrail |
| `knowledge` | `agent.knowledge.search` spans (failed; empty ones are reported in the reason, not failed), `agent.knowledge.error` events, `agent.tool.call` spans of the knowledge layer | 1 - failed / total |
| `llm` | `agent.model.call` spans (error, `agent.model.finish` `limit` or `refused`), else `model.reply` events (`finish`); a run that stopped because the model did: reason layer `llm`, last call errored, last answer cut off or refused | 1 - bad / calls, 0 when the run ended because of the model |
| `cache` | `agent.cache.lookup` spans | 1 - failed lookups / lookups; a miss is healthy, the reason has the hit rate |
| `harness` | the run status and stop reason | 1 if completed; 1 if `waiting` (a person was asked, reason `waiting: <code>`); 0 for `failed` or `stopped` not blamed on a guard or the model |

## Attribution

After the health scores the evaluator adds one score, `attributed`: the layer to fix. It is the worst-scored layer other
than `harness` among those below 1; `harness` only when nothing else is below 1. Ties go to the layer that comes first
in the core `LAYERS` list. The score carries that layer, its value, and the reason `<layer>: <its reason>`; when every
layer is healthy it is `{ metric: 'attributed', value: 1, reason: 'none' }` with no layer. With the `layers` option the
rule applies to the layers reported.

The rule is exported for other callers: `attributeLayer(scores)` returns `{ layer, value, reason }` or `undefined`, and
`attributedScore(scores)` builds the score.

## Input

`EvalRun.events` may hold two kinds of items, mixed. Anything else is ignored.

- Run events, as the runtimes write them: `run.end { status, reason? }`, `model.reply { finish }`,
  `tool.result { tool, ok }`.
- Telemetry records, as `recordingTelemetry` writes them (`{ type: 'span', name, layer, status, attrs }`), read by the
  core span names (`SPAN`) and attribute names (`ATTR`) listed above. Spans give the full picture; run events cover what
  a runtime reports without telemetry. When both exist for a layer, the spans win.

The run supplies `status` and, when present, the structured `reason` (`EvalRun.reason`); without it the reason comes from
the last `run.end` event, then from the stop code on the `agent.run` span. `agent-layers eval` passes the run result, so
it scores `harness`, `tool`, `llm` and a guard stop from the run events alone. For the rest, record telemetry and attach
it to the run before scoring:

```ts
import { compose } from '@agent-layers/core';
import { createLayerSignals, createSignalRecorder } from '@agent-layers/adapter-layer-signals';

const recorder = createSignalRecorder();
const stack = await compose(config, { telemetry: [recorder.telemetry] });
const result = await (await stack.agent('assistant')).run(testCase.input);
const scores = await createLayerSignals().score(testCase, recorder.attach(result));
```

Records carry no run id, so attach them after each run; a dataset run is sequential. `attach` appends the records written
since the last call (`take()` returns them as they are). The pure form is `scoreLayers(items, { status, reason? })`.
Adapter events and other run event types are not read.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `layers` | string[] | all | Report only these layers (and attribute among them) |
| `reasonChars` | integer | `160` | Characters of a stop reason `detail` kept in the llm and harness score reasons |
| `previewItems` | integer | `3` | Names listed in a score reason (guards, denied tools, failed tools) |

Limits accept `${env:NAME}`. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{ "layers": { "eval": [{ "adapter": "layer-signals" }, { "adapter": "expected-eval" }] } }
```
