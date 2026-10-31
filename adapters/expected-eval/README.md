# @agent-layers/adapter-expected-eval

Maps **expected answers** → **EvaluatorPort** (layer `eval`). Tier: prototype, production.

Scores a run 1 or 0 by comparing its output with the `expected` field of the dataset case. Cases without `expected`
get no score. `expected` can be a string, a list of strings (any one matches) or `{ "all": [...] }` (every one must
match). A run whose status is not `completed` (`failed`, `stopped` or `waiting`) scores 0 with the reason `run <status>`.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `contains` \| `equals` \| `regex` | `contains` | How output and expected answer are compared |
| `caseSensitive` | boolean | `false` | Case-sensitive comparison |
| `metric` | string | `expected` | Metric name of the score |
| `layer` | layer id | none | Layer attached to the scores, for example `knowledge` |
| `maxQuoteChars` | integer | `60` | Characters of an expected answer quoted in a score reason |

Limits accept `${env:NAME}`. Ranges and checks: [docs/limits.md](../../docs/limits.md).

```json
{ "layers": { "eval": [{ "adapter": "expected-eval", "options": { "mode": "contains", "layer": "knowledge" } }] } }
```
