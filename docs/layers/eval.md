# Evaluation & improvement

Layer id `eval` (L10), Insight plane. *Was it good, and if not, which layer failed?*

## Responsibility

Measure quality continuously and find which layer a failure belongs to, so fixes land in the right place.

## Ports

| Port | What it does |
|---|---|
| [EvaluatorPort](../../spec/ports/EvaluatorPort.md) | `score` a run of a dataset case into `EvalScore` values, each optionally attributed to a layer |
| [FeedbackPort](../../spec/ports/FeedbackPort.md) | `submit` and `list` user feedback attached to runs, as evaluation data |

Data shapes: [eval-case.json](../../spec/schemas/eval-case.json), [eval-result.json](../../spec/schemas/eval-result.json),
[feedback.json](../../spec/schemas/feedback.json).

### Where it sits

```mermaid
flowchart LR
  cli["agent-layers test, eval"]:::external --> ev
  users["Users<br/>ratings, comments"]:::external --> fb
  subgraph sg["L10 eval"]
    ev["EvaluatorPort<br/>score"]:::insight
    fb["FeedbackPort<br/>submit, list"]:::insight
  end
  ev -->|"replay the case"| harness["L3 harness"]:::agent
  ev -->|"judge"| llm["L1 llm"]:::model
  ev -->|"run events"| telemetry["L9 telemetry"]:::insight
  classDef model fill:#ffd8a8,stroke:#a85400,color:#1f2328
  classDef agent fill:#a5d8ff,stroke:#1864ab,color:#1f2328
  classDef insight fill:#d0bfff,stroke:#5f3dc4,color:#1f2328
  classDef external fill:#ffffff,stroke:#57606a,color:#1f2328,stroke-dasharray:4 3
```

## Standards

None. The data formats (dataset and result JSON Lines) are defined by this repository, so any runner that reads
`EvalCase` and writes the result format works.

## Improvement loop

Each failure is attributed to one layer, fixed there, and kept as a regression case.

```mermaid
flowchart LR
  run["Run: dataset case<br/>or production trace"]:::external --> score["EvaluatorPort.score<br/>scores per layer"]:::insight
  score --> diag{"Failed?<br/>which layer"}:::insight
  diag -->|"harness"| h["L3 harness<br/>prompt, budget"]:::agent
  diag -->|"knowledge"| k["L4 knowledge<br/>retrieval tuning"]:::agent
  diag -->|"tool"| t["L5 tool<br/>clearer description"]:::agent
  diag -->|"identity, guardrail"| c["L6, L7<br/>policy or guard rule"]:::control
  h --> reg["Failing case joins the dataset<br/>as a regression test"]:::insight
  k --> reg
  t --> reg
  c --> reg
  reg --> run
  classDef agent fill:#a5d8ff,stroke:#1864ab,color:#1f2328
  classDef control fill:#ffc9c9,stroke:#b42318,color:#1f2328
  classDef insight fill:#d0bfff,stroke:#5f3dc4,color:#1f2328
  classDef external fill:#ffffff,stroke:#57606a,color:#1f2328,stroke-dasharray:4 3
```

## Boundaries

- One evaluator per concern: answer quality, retrieval quality, tool correctness, policy decisions, guardrail false
  positives, cache hit rate.
- **Replay.** Re-running stored inputs with another agent or model gives regression runs and A/B comparisons without
  new data.
- **Improvement loop.** Failures become dataset cases, fixes land in the owning layer, regression tests keep them fixed.
  Red-team cases belong here too; see [governance](../cross-cutting/governance-compliance.md).
- A diagnose agent reads a failing run and attributes the failure to one layer id.

## How to swap

Dataset and results are plain JSONL. Other frameworks (RAGAS, DeepEval, Opik, promptfoo, custom scripts) plug in as
evaluators on EvaluatorPort, checked with the conformance suite.

## Reference adapters

| Adapter | Maps |
|---|---|
| `expected-eval` | Expected answers |
| `judge-eval` | Model-as-judge |
| `layer-signals` | Per-layer health scores from run events |

Planned: promptfoo. Full list: [adapters.md](../adapters.md).

## Reference setup

[`reference/eval/`](../../reference/eval/README.md) uses promptfoo (MIT) as the test runner with a provider that runs
the agent in process, a smoke dataset (`EVAL_DATASET`) and a diagnose agent. Replay and layer attribution come from the
reinloop runtime.

```bash
make test LAYER=eval
```

The test runs the smoke dataset, validates the result file, and checks that the diagnose agent returns a layer id.
