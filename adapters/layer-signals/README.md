# @agent-layers/adapter-layer-signals

Maps **per-layer signals from run events and telemetry** → **EvaluatorPort** (layer `eval`). Tiers: prototype,
production. Maturity: experimental.

Turns a run into one health score per layer, so a failing case points at the layer to fix. Each score is
`<layer>_health` (1 = healthy, 0 = failed), carries the `layer`, and has a reason with counts and names, never content.
A layer without any signal gets no score.

| Layer | Signal | Score |
|---|---|---|
| `guardrail` | `guard.check` spans; a run stopped with reason `guardrail:...` | 0 if anything was blocked, 0.5 if only redacted, else 1 |
| `identity` | `authorize` spans | 1 - denied / decisions |
| `tool` | `execute_tool` spans (`tool.outcome` `error`), else `tool_result` events with `isError` | 1 - failed / calls; denied and blocked calls belong to identity and guardrail |
| `knowledge` | `knowledge.search` spans (failed or empty), `execute_tool` spans of the knowledge layer | 1 - bad / total |
| `llm` | `chat` spans (error, finish reason `length`, `content_filter`), else `model_response` events (`finish_reason`); a failed run whose reason is a provider or network error | 1 - bad / calls, 0 for a provider failure |
| `cache` | `cache.lookup` spans | 1 - failed lookups / lookups; a miss is healthy, the reason has the hit rate |
| `harness` | the run status and reason | 1 if completed; 0 for any other status not blamed on a guard or the model |

## Input

`EvalRun.events` may hold two kinds of items, mixed. Anything else is ignored.

- Runtime events (flat fields, as `basic-runtime` writes them): `run_end { status, reason? }`,
  `model_response { finish_reason? }`, `tool_result { name?, isError? }`.
- Telemetry records, as `recordingTelemetry` writes them (`{ type: 'span', name, layer, status, attrs }`), read by span
  name and the attributes listed above. Spans give the full picture; runtime events cover what a runtime reports without
  telemetry. When both exist for a layer, the spans win.

The run supplies `status` and, when present, `reason` (`RunResult` has it; the type `EvalRun` does not).
`agent-layers eval` passes the run result, so it scores `harness`, `tool`, `llm` and a guard stop from the runtime events
alone. For the rest, record telemetry and append it to the events before scoring:

```ts
import { compose } from '@agent-layers/core';
import { createLayerSignals, createSignalRecorder } from '@agent-layers/adapter-layer-signals';

const recorder = createSignalRecorder();
const stack = await compose(config, { telemetry: [recorder.telemetry] });
const result = await (await stack.agent('assistant')).run(testCase.input);
const scores = await createLayerSignals().score(testCase, { ...result, events: [...(result.events ?? []), ...recorder.take()] });
```

Records carry no run id, so take them after each run; a dataset run is sequential. The pure form is
`scoreLayers(items, { status, reason? })`. Compaction events and other runtime-specific types are not read.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `layers` | string[] | all | Report only these layers |

```json
{ "layers": { "eval": [{ "adapter": "layer-signals" }, { "adapter": "expected-eval" }] } }
```
