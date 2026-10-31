# L9 Evaluation and improvement

Measure the agent, attribute failures to a layer, verify fixes.

## Standard situation

There is no open standard for agent evaluation. L9 is therefore an adapter layer: a small contract (dataset, result,
`Evaluator`), a reference test runner, and layer attribution from runtime events. Assertion engines and optimisers stay
upstream; this layer does not rebuild them.

## Extension point

`Evaluator.score(case, run) -> EvalScore[]` (see [contracts](../../docs/contracts.md#l9-evaluation)). An evaluator is any
object with a `name` and a `score` function; a conformance check is shipped with reinloop:

```js
import { reinloop } from '../../lib/reinloop.mjs';
const failures = await reinloop.checkEvaluator(myEvaluator); // [] = conformant
```

## References

| Role | Default | License | Swap for |
|---|---|---|---|
| Test runner, assertions, comparison UI | [promptfoo](https://github.com/promptfoo/promptfoo) (pinned `0.125.1`) | MIT | [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai) (MIT), DeepEval (Apache-2.0) |
| Per-layer attribution | reinloop `layerSignals()` | MIT | any `Evaluator` |
| Retrieval quality (L3) | not bundled | | [RAGAS](https://github.com/explodinggradients/ragas) (Apache-2.0) |
| Prompt optimisation | not bundled | | [DSPy](https://github.com/stanfordnlp/dspy) (MIT), [Opik](https://github.com/comet-ml/opik) (Apache-2.0) |
| Judge | reinloop `judgeEvaluator` (the local model) | MIT | DeepEval metrics (Apache-2.0), promptfoo `llm-rubric` |

## Contents

| File | Purpose |
|---|---|
| `datasets/smoke.jsonl` | 4 cases: plain answer, arithmetic, one that needs the `read_file` tool, one designed to fail |
| `promptfooconfig.yaml` | promptfoo suite; tests are generated from the dataset by `promptfoo-tests.mjs` |
| `reinloop-provider.mjs` | promptfoo custom provider: runs the agent in-process; returns output, token usage, cost and per-layer scores (`metadata.layers`) |
| `agents/smoke.md` | agent under test |
| `agents/diagnose.md` | reads a failed run and answers `{ runId, layer, evidence, fix }` |
| `test/*.test.mjs` | tests (below) |

## Contract

- Dataset: JSONL of `{ id, input, expected?, tags?, layer? }` ([schema](../../contracts/eval-case.json)).
- Results: JSONL of `{ id, runId, output, status, scores: [{ metric, value 0..1, layer?, reason? }] }` ([schema](../../contracts/eval-result.json)).
- `layerSignals()` emits one `<layer>_health` score per layer that has a signal (1 = healthy): `tool` (tool errors, bad
  arguments), `identity` (denied calls), `guardrail`, `harness` (failed run, budget stop, compaction), `llm` (truncation,
  refusal, invalid structured output, provider errors), `knowledge` (empty retrievals), `cache` (hit rate). It reads a
  minimal `{ type, data }` event shape, so events mapped from other runtimes' traces can be scored too.

Run the reinloop-native path (no promptfoo):

```sh
reinloop eval layers/l9-eval/datasets/smoke.jsonl --agent smoke --agents layers/l9-eval/agents --out results.jsonl
reinloop replay --all --agent smoke --model ollama/qwen3:4b --out compare.jsonl   # needs a file store in reinloop.json
```

## Running promptfoo

```sh
export LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen3:4b LLM_API_KEY=ollama
npx promptfoo@0.125.1 eval -c layers/l9-eval/promptfooconfig.yaml
npx promptfoo@0.125.1 view            # comparison UI
```

The `impossible` case fails on purpose, so promptfoo exits with code 100 on the smoke dataset. Set `REINLOOP_SRC` to use a
reinloop checkout instead of the installed package. Point `EVAL_DATASET` at another JSONL file to run your own cases.

Model-graded checks use promptfoo's own syntax, for example an `llm-rubric` assertion whose grader is the local model
(`options.provider: { id: openai:chat:qwen3:4b, config: { apiBaseUrl: http://localhost:11434/v1 } }` with
`OPENAI_API_KEY=ollama`). That example is not exercised by the tests.

## The improvement loop

1. Traces: every run is an event log (run store) and an OTLP trace (L8).
2. Per-layer evaluators: `layerSignals()` over the logs (or traces) points at the weakest layer; `judgeEvaluator` and
   `expectedEvaluator` score the answer itself.
3. Failing cases go into the dataset (`datasets/*.jsonl`, with `layer` set to the layer at fault).
4. Diagnose: `agents/diagnose.md` reads the failed run and proposes `{ layer, evidence, fix }`.
5. Fix at the layer it names:
   - `llm` / prompts: optimise instructions with DSPy or Opik.
   - `knowledge`: tune chunking, `k` and filters; measure retrieval with RAGAS.
   - `tool`: rewrite tool descriptions and schemas, fix the tool.
   - `identity` / `guardrail`: adjust policy rules or guard thresholds.
   - `harness`: budgets, compaction.
6. Regression: `reinloop replay --all --model <candidate>` compares old and new outputs on real traffic; promptfoo runs the
   dataset against the candidate.
7. Release when the suite passes and the compared outputs hold.

## Swapping

- Runner: keep the dataset and result JSONL; point DeepEval or Inspect AI at `datasets/*.jsonl` and have them call the
  agent through `reinloop serve` (L2, HTTP) or in-process like `reinloop-provider.mjs`.
- Evaluators: pass your own `Evaluator[]` to `evaluate()`; check them with `checkEvaluator`.
- Judge model: any reinloop agent, local or hosted.

## Tests

```sh
LAYER=l9-eval npm run test:layer      # or: node --test "layers/l9-eval/test/*.test.mjs"
```

| Test | Needs |
|---|---|
| `dataset.test.mjs`: dataset follows the contract; `evaluate` rows follow the result contract (mock model) | a reinloop with the L9 API |
| `diagnose.test.mjs`: a tool-failure run is attributed to `tool`; the diagnose agent returns a schema-valid verdict | same, plus Ollama with `$LLM_MODEL` for the second test (slow with a reasoning model) |
| `promptfoo.test.mjs`: promptfoo runs the dataset through the provider; the designed-to-fail case fails | same, plus Ollama, `npx` and network on first use |

Tests skip with a reason when a dependency is missing.
