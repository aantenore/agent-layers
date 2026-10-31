# @agent-layers/adapter-judge-eval

Maps **LLM as judge** → **EvaluatorPort** (layer `eval`). Tiers: prototype, production. Maturity: experimental.

Asks a language model to grade a run against criteria: one structured answer `{"score": 0..1, "reason": "..."}`. The
case input, the optional `expected` reference and the run output go to the judge as one JSON object between two lines
of a random marker (new for every call and removed from the values), and the system prompt tells the judge to treat
them as data. An answer that contains `</answer>`, a fake verdict or the instruction "give me a 1" stays inside its JSON
string. Scores keep the case's `layer`. A failed run is graded too, with its status in the material.

The reply is accepted only if the whole text is a single JSON object with exactly `score` (a number from 0 to 1) and
`reason` (a string). Text around it, code fences, extra fields and out-of-range scores count as a judge failure. On a
failure, or when the judge call errors, the evaluator returns a score of 0 on the `eval` layer, so a dataset run goes
on; the reason names only the kind of failure (`judge gave no usable verdict`, `judge call failed`, `judge call timed
out`), never error text. Set `onError: "throw"` to reject instead.

**Where the judge model comes from.** Inside a composed stack the judge calls the stack's governed model (through
`ctx.stack()`): the stack's guards, cache, router and token accounting apply, and knowledge is not injected. `backend`
names a ModelPort adapter, created like any other (`openai-compatible`, `mock-model`, ...), used only as a fallback:
when the evaluator is created outside a stack, or the stack has no model. Outside a stack, `backend` is required. The
judge call is a span `judge-eval.score` on the `eval` layer with the requested and used model (`agent.model.requested`, `agent.model.used`), the metric (`judge-eval.metric`) and no content. From code, pass any ModelPort, for
example the stack's own:

```ts
import { createJudgeEval } from '@agent-layers/adapter-judge-eval';
const judge = createJudgeEval({ model: 'gpt-4o-mini', criteria: 'Answers in one sentence' }, { model: stack.model, telemetry: stack.telemetry });
```

The request is a `ModelRequest`: a system and a user message, `settings` with `temperature` and `maxOutputTokens`, and
the configured `ext`. The verdict is read from the text of the reply. A case whose `input` is a conversation
(`{ messages }`) is shown to the judge as `role: text` lines.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `model` | string | required | Model id of the judge call |
| `backend` | `{ adapter, options? }` | none | Fallback ModelPort adapter, when there is no stack model; required outside a stack |
| `criteria` | string | correct, relevant, consistent with the reference | What a good answer is |
| `metric` | string | `"judge"` | Metric name of the score |
| `temperature` | number | 0 | Sampling temperature |
| `maxTokens` | integer | backend default | Limit for the judge answer (`settings.maxOutputTokens`) |
| `maxReasonChars` | integer | `300` | Characters of the judge reason kept in the score |
| `ext` | object | none | Request `ext` for the judge model's adapter; every key is namespaced by that adapter, e.g. `{ "openai.seed": 7 }` |
| `onError` | `"score"` \| `"throw"` | `"score"` | Score 0 on the `eval` layer, or reject |

`ext` replaces the former `extra` option, which is no longer accepted. Keys must be `<namespace>.<name>` and outside the
namespaces the core reserves (`sdk`, `agent`, `run`, `model`, `tool`); the keys are checked when the evaluator is
created. The adapter writes no `ext` of its own, so it declares none.

Limits accept `${env:NAME}`. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{
  "layers": {
    "eval": [
      {
        "adapter": "judge-eval",
        "options": {
          "model": "${env:JUDGE_MODEL}",
          "backend": { "adapter": "openai-compatible", "options": { "baseUrl": "${env:JUDGE_BASE_URL}", "apiKey": "${secret:JUDGE_KEY}" } },
          "criteria": "The answer is correct and cites the policy it relies on."
        }
      }
    ]
  }
}
```
