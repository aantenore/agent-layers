# EvaluatorPort

Layer: `eval` (L10 Evaluation & improvement) · Version: 1.0.0 · Conformance: `checkEvaluator`

## Purpose

Score how good a run was against a dataset case, and say which layer is to blame when it was not. A developer runs a dataset and gets per-metric scores that point at retrieval, tools, guardrails or the model.

## Operations

- `score(c: EvalCase, run: EvalRun) → [EvalScore]`
  Evaluate one run of one case and return zero or more scores, one per metric.

## Data shapes

[EvalCase](../schemas/eval-case.json) (one line of a dataset file):

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | String, required | Case id. |
| `input` | RunInput, required | Input given to the agent: a string, or `{messages: [Message]}` (see [RuntimePort](RuntimePort.md)). |
| `expected?` | Any | Reference answer or structured expectation; free-form. |
| `tags?` | [String] | Free labels. |
| `layer?` | Layer id | Layer the case is meant to exercise. |
| `ext?` | Ext | Dataset-specific fields. |

`EvalRun`: `runId: String`, `output?: String`, `status: RunStatus` (as in [RunResult](../schemas/run-result.json)), `reason?: StopReason` (structured: `{code, layer?, by?, stage?, detail?}`), `events?: [RunEvent]`.

`EvalScore` (defined in [eval-result.json](../schemas/eval-result.json) as `EvalScore`): `metric: String`, `value: Number` in [0, 1] (both required), `layer?: Layer id` (the layer the score blames or concerns), `reason?: String`, `ext?: Ext`.

[EvalResult](../schemas/eval-result.json) (one line of a result file): `id` (the case id), `runId`, `output`, `status`, `scores: [EvalScore]`, and, when the run reports them, `reason?` (structured stop reason), `usage?` (`{inputTokens, outputTokens}` as in [ModelPort](ModelPort.md)) and `costUsd?` (as in RunResult).

## Semantics

- Scoring one run has no effect on the agent or on the dataset.
- A score is a number in [0, 1]; the meaning belongs to the metric, and the metric name is stable so results can be compared across runs.
- When a score points at a failing layer, set `layer`; that is how a dataset run turns into "which layer failed". A run that did not complete says why in `run.reason` (`code`, `layer`, `by`, `stage`), so an evaluator reads the stop code instead of parsing text.
- An evaluator may look at `run.events` to attribute failures. It relies on the core event types (`run.start`, `model.reply`, `tool.call`, `tool.result`, `text`, `run.end`); adapter events (`<namespace>.<name>`) are the adapter's, and an evaluator that reads them says which runtime it supports.
- A failed run (`status` other than `completed`) is still scored; the evaluator decides whether it gets a score of 0 or no score.
- An evaluator that calls a model for judging must use the stack's model port, so cost, guards and telemetry apply.
- Returning an empty list means "no opinion on this case".

## Errors

- Rejects: the evaluator cannot run (judge unavailable, invalid case). Runner behaviour for a rejected case is up to the runner, which should record the failure rather than drop the case.
- Returned as a result: a bad run is a low score, not an error.

## Escape hatch

`EvalCase.expected` is free-form. `EvalScore.reason` carries free text. `ext` on cases, scores and results carries evaluator-specific data (for example judge details) under namespaced keys declared in the adapter descriptor's `ext.produces` / `ext.reads`. `native()` returns the underlying evaluation framework.

## Conformance

`checkEvaluator` verifies, for each fixture case:

- The case validates against `eval-case.json`.
- `score` resolves to an array and each score validates against the `EvalScore` definition.
- When an expected metric value is given, the score for that metric equals it.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): `EvalCase.input` is a `RunInput`; `EvalRun.reason` and `EvalResult.reason` are structured; evaluators read the core event types
- 0.2.0 — optional `usage` and `costUsd` on EvalResult
- 0.1.0 — initial

Example adapters: `expected-eval` (maps expected answers).
