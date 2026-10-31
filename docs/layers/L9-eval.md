# L9 Evaluation & improvement

## Purpose

Measure quality continuously and find which layer a failure belongs to, so fixes land in the right place.

## Standard

None. promptfoo is the de facto tool for prompt and agent evals; the data formats here are defined by this
repository.

## Extension point

`Evaluator.score(case, run) → EvalScore[]`. One evaluator per concern (answer quality, retrieval quality, tool
correctness, policy decisions, guardrail false positives, cache hit rate).

## Reference implementation

| Role | Reference | License |
|---|---|---|
| Eval runner | promptfoo | MIT |
| Replay | `reinloop replay` | MIT |
| Attribution | diagnose agent (a reinloop agent file) | MIT |

`reinloop replay` re-runs stored inputs with another agent or model, which gives regression runs and A/B comparisons
without new data.

## How to swap it

The dataset and results are plain JSONL. Any runner that reads `EvalCase` and writes the result format works; the
promptfoo provider is one thin wrapper that calls reinloop. Other frameworks (RAGAS, DeepEval, Opik, custom
scripts) plug in as `Evaluator`s.

## Contract

- Dataset line: `EvalCase { id, input, expected?, tags?, layer? }`.
- Result line: `{ id, runId, output, status, scores: EvalScore[] }`, `EvalScore { metric, value, layer?, reason? }`.
- Diagnose agent output: `{ runId, layer, evidence, fix }`.

Schemas: [eval-case.json](../../contracts/eval-case.json), [eval-result.json](../../contracts/eval-result.json).
Details in [contracts.md](../contracts.md#l9-evaluation).

## Adapter SDK

`Evaluator` plus the dataset/result JSONL formats. A conformance check validates every line of a dataset and a
result file against the schemas.

## How to test

```bash
make test LAYER=l9-eval
```

Runs the smoke dataset (`EVAL_DATASET`) through reinloop, validates the result file, and checks that the diagnose
agent returns a layer from the enum. See the [improvement loop](../../README.md#improvement-loop).
