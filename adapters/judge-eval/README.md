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

**Where the judge model comes from.** An evaluator does not receive the stack's model port, so `backend` names a
ModelPort adapter that is created in the same way as any other (`openai-compatible`, `mock-model`, ...). Calls go
straight to that model: the stack's guards, cache, router and cost accounting do not apply to them. The judge call is a
span on the `eval` layer with the model name and no content. From code, pass any ModelPort, for example the stack's own:

```ts
import { createJudgeEval } from '@agent-layers/adapter-judge-eval';
const judge = createJudgeEval({ model: 'gpt-4o-mini', criteria: 'Answers in one sentence' }, { model: stack.model, telemetry: stack.telemetry });
```

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `model` | string | required | Model id sent to the judge backend |
| `backend` | `{ adapter, options? }` | required in config | ModelPort adapter that serves the judge |
| `criteria` | string | correct, relevant, consistent with the reference | What a good answer is |
| `metric` | string | `"judge"` | Metric name of the score |
| `temperature` | number | 0 | Sampling temperature |
| `maxTokens` | integer | backend default | Limit for the judge answer |
| `extra` | object | none | Passed to the backend, e.g. `{ "response_format": { "type": "json_object" } }` |
| `onError` | `"score"` \| `"throw"` | `"score"` | Score 0 on the `eval` layer, or reject |

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
