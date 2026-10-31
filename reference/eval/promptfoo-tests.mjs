// Turns the eval dataset (JSONL of EvalCase) into promptfoo tests, so the dataset stays the single source of truth.
// `expected`: a string -> icontains; { contains } -> icontains; { equals } -> equals; { regex } -> regex.
// Every test also asserts the run completed (the provider reports a non-completed run as an error).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function assertions(expected) {
  if (expected === undefined || expected === null) return [];
  if (typeof expected === 'string') return [{ type: 'icontains', value: expected }];
  const out = [];
  for (const needle of [].concat(expected.contains ?? [])) out.push({ type: 'icontains', value: needle });
  if (typeof expected.equals === 'string') out.push({ type: 'equals', value: expected.equals });
  if (typeof expected.regex === 'string') out.push({ type: 'regex', value: expected.regex });
  return out;
}

export default function generateTests(config = {}) {
  const dataset = resolve(root, config.dataset ?? process.env.EVAL_DATASET ?? 'reference/eval/datasets/smoke.jsonl');
  return readFileSync(dataset, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const c = JSON.parse(line);
      return {
        description: c.id,
        vars: { input: c.input },
        assert: assertions(c.expected),
        metadata: { id: c.id, tags: c.tags ?? [], layer: c.layer },
      };
    });
}
