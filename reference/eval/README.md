# Eval reference setup

Layer page: [docs/layers/eval.md](../../docs/layers/eval.md). Measure the agent, attribute failures to a layer, verify fixes.

## Standard situation

There is no open standard for agent evaluation. The eval layer is therefore an adapter layer: a small contract (dataset, result,
`Evaluator`), a reference test runner, and layer attribution from runtime events. Assertion engines and optimisers stay
upstream; this layer does not rebuild them.

## Extension point

`Evaluator.score(case, run) -> EvalScore[]` (port: [EvaluatorPort](../../spec/ports/EvaluatorPort.md)). An evaluator is any
object with a `name` and a `score` function; the conformance check ships with `@agent-layers/conformance`:

```js
import { checkAdapter } from '@agent-layers/conformance';
const { failures } = await checkAdapter(myEvaluatorAdapter); // [] = conformant
```

## References

| Role | Default | License | Swap for |
|---|---|---|---|
| Test runner, assertions, comparison UI | [promptfoo](https://github.com/promptfoo/promptfoo) (pinned `0.125.1`) | MIT | [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai) (MIT), DeepEval (Apache-2.0) |
| Per-layer attribution | `@agent-layers/adapter-layer-signals` | MIT | any `Evaluator` |
| Retrieval quality (`knowledge`) | not bundled | | [RAGAS](https://github.com/explodinggradients/ragas) (Apache-2.0) |
| Prompt optimisation | not bundled | | [DSPy](https://github.com/stanfordnlp/dspy) (MIT), [Opik](https://github.com/comet-ml/opik) (Apache-2.0) |
| Expected answers | `@agent-layers/adapter-expected-eval` | MIT | any `Evaluator` |
| Judge | `@agent-layers/adapter-judge-eval` (the stack's model) | MIT | DeepEval metrics (Apache-2.0), promptfoo `llm-rubric` |

## Contents

| File | Purpose |
|---|---|
| `datasets/smoke.jsonl` | 4 cases: plain answer, arithmetic, one that needs the `read_file` tool, one designed to fail |
| `promptfooconfig.yaml` | promptfoo suite; tests are generated from the dataset by `promptfoo-tests.mjs` |
| `agent-provider.mjs` | promptfoo custom provider: runs the agent in-process through a composed stack (`compose`, `openai-compatible` model, `basic-runtime`, a `read_file` tool); returns output, token usage, cost and per-layer scores (`metadata.layers`) |
| `agents/smoke.md` | agent under test (its instructions are the file body) |
| `agents/diagnose.md` | reads a failed run and answers `{ runId, layer, evidence, fix }` |
| `test/*.test.mjs` | tests (below) |

## Contract

- Dataset: JSONL of `{ id, input, expected?, tags?, layer? }` ([schema](../../spec/schemas/eval-case.json)).
- Results: JSONL of `{ id, runId, output, status, scores: [{ metric, value 0..1, layer?, reason? }] }` ([schema](../../spec/schemas/eval-result.json)).
- `layer-signals` emits one `<layer>_health` score per layer that has a signal (1 = healthy), then `attributed`: the layer to
  fix. Signals: `tool` (failed calls), `identity` (denied calls), `guardrail`, `harness` (failed or stopped run), `llm`
  (truncation, refusal, provider errors), `knowledge`, `cache`. It reads run events and telemetry records, so a run from
  any runtime that reports `RunEvent`s can be scored.
- `expected-eval` scores `expected` by `contains` (default), `equals` or `regex`: a string, a list (any matches) or
  `{ all: [...] }`. The object form `{ contains, equals, regex }` of the dataset is promptfoo-only (`promptfoo-tests.mjs`).

Run the SDK path (no promptfoo): a project with `eval` adapters in `agent-layers.json` and the agent to measure:

```sh
agent-layers eval reference/eval/datasets/smoke.jsonl --agent smoke --out results.jsonl --min 0.5
```

## Running promptfoo

```sh
export LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen3:4b LLM_API_KEY=ollama
npx promptfoo@0.125.1 eval -c reference/eval/promptfooconfig.yaml
npx promptfoo@0.125.1 view            # comparison UI
```

The `impossible` case fails on purpose, so promptfoo exits with code 100 on the smoke dataset. Point `EVAL_DATASET` at another JSONL file to run your own cases.

Model-graded checks use promptfoo's own syntax, for example an `llm-rubric` assertion whose grader is the local model
(`options.provider: { id: openai:chat:qwen3:4b, config: { apiBaseUrl: http://localhost:11434/v1 } }` with
`OPENAI_API_KEY=ollama`). That example is not exercised by the tests.

## The improvement loop

1. Traces: every run is an event log (run store) and an OTLP trace (`telemetry`).
2. Per-layer evaluators: `layer-signals` over the run events (or traces) points at the weakest layer; `judge-eval` and
   `expected-eval` score the answer itself.
3. Failing cases go into the dataset (`datasets/*.jsonl`, with `layer` set to the layer at fault).
4. Diagnose: `agents/diagnose.md` reads the failed run (its events as JSONL) and proposes `{ layer, evidence, fix }`.
5. Fix at the layer it names:
   - `llm` / prompts: optimise instructions with DSPy or Opik.
   - `knowledge`: tune chunking, `k` and filters; measure retrieval with RAGAS.
   - `tool`: rewrite tool descriptions and schemas, fix the tool.
   - `identity` / `guardrail`: adjust policy rules or guard thresholds.
   - `harness`: budgets, compaction.
6. Regression: promptfoo runs the dataset against the candidate (`model` in the provider config); `agent-layers eval` with
   `--min` gates a release on the pass rate.
7. Release when the suite passes and the compared outputs hold.

## Swapping

- Runner: keep the dataset and result JSONL; point DeepEval or Inspect AI at `datasets/*.jsonl` and have them call the
  agent through the gateway (HTTP) or in-process like `agent-provider.mjs`.
- Evaluators: list your own `EvaluatorPort` adapters under `layers.eval`; check them with `checkAdapter`.
- Judge model: any `ModelPort` adapter, local or hosted (`judge-eval`).

## Tests

```sh
LAYER=eval npm run test:layer      # or: node --test "reference/eval/test/*.test.mjs"
```

| Test | Needs |
|---|---|
| `dataset.test.mjs`: dataset follows the contract; `expected-eval` passes conformance; `agent-layers eval` rows follow the result contract (mock model) | nothing external |
| `diagnose.test.mjs`: a tool-failure run is attributed to `tool` and `layer-signals` passes conformance; the diagnose agent returns a schema-valid verdict | nothing for the first test; Ollama with `$LLM_MODEL` for the second (slow with a reasoning model) |
| `promptfoo.test.mjs`: promptfoo runs the dataset through the provider; the designed-to-fail case fails | Ollama, `npx` and network on first use |

Tests skip with a reason when a dependency is missing.
