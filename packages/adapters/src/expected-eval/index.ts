import { defineAdapter, LAYERS, limitProperties, limitValue, PORT_VERSIONS, type EvalScore, type EvaluatorPort, type Layer } from '@agent-layers/core';
import { LIMITS } from './limits.ts';

export interface ExpectedEvalOptions {
  /** How the output is compared with an expected answer (default `contains`). */
  mode?: 'contains' | 'equals' | 'regex';
  /** Case-sensitive comparison (default false). */
  caseSensitive?: boolean;
  /** Metric name of the score (default `expected`). */
  metric?: string;
  /** Layer id attached to the scores. */
  layer?: Layer;
  /** Characters of an expected answer quoted in a score reason (default 60). */
  maxQuoteChars?: number;
}

type Expectation = { kind: 'any' | 'all'; answers: string[] };

/** `expected` as a string, a list (any matches) or `{ all: [...] }` (all must match). */
function expectation(expected: unknown): Expectation | undefined {
  const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined);
  const list = (v: unknown) => (Array.isArray(v) ? v.map(text).filter((s): s is string => s !== undefined) : undefined);
  const single = text(expected);
  if (single !== undefined) return { kind: 'any', answers: [single] };
  const any = list(expected);
  if (any) return { kind: 'any', answers: any };
  const all = list((expected as { all?: unknown } | null)?.all);
  return all ? { kind: 'all', answers: all } : undefined;
}

/** Evaluator that checks a run's output against the expected answer of its dataset case. */
export function createExpectedEval(options: ExpectedEvalOptions = {}, name = 'expected-eval'): EvaluatorPort {
  const mode = options.mode ?? 'contains';
  const metric = options.metric ?? 'expected';
  const maxQuote = limitValue(LIMITS.maxQuoteChars, options.maxQuoteChars);
  const short = (s: string) => (s.length > maxQuote ? `${s.slice(0, maxQuote - 3)}...` : s);
  const fold = options.caseSensitive ? (s: string) => s : (s: string) => s.toLowerCase();
  const score = (value: number, reason: string): EvalScore[] => [{ metric, value, ...(options.layer ? { layer: options.layer } : {}), reason }];

  const matches = (output: string, answer: string): boolean => {
    if (mode === 'regex') return new RegExp(answer, options.caseSensitive ? 'u' : 'iu').test(output);
    if (mode === 'equals') return fold(output.trim()) === fold(answer.trim());
    return fold(output).includes(fold(answer));
  };

  return {
    name,
    async score(c, run) {
      const exp = expectation(c.expected);
      if (!exp || exp.answers.length === 0) return [];
      if (run.status !== 'completed') return score(0, `run ${run.status}`);
      const output = run.output ?? '';
      try {
        const hits = exp.answers.filter((a) => matches(output, a));
        if (exp.kind === 'all') {
          const missed = exp.answers.find((a) => !hits.includes(a));
          return missed === undefined ? score(1, 'all expected answers found') : score(0, `${mode} failed for "${short(missed)}"`);
        }
        return hits.length ? score(1, `matched "${short(hits[0]!)}"`) : score(0, `${mode} failed for "${short(exp.answers[0]!)}"`);
      } catch {
        return score(0, 'invalid regex in expected answer');
      }
    },
  };
}

export const adapter = defineAdapter<'EvaluatorPort', ExpectedEvalOptions>({
  layer: 'eval',
  port: 'EvaluatorPort',
  name: 'expected-eval',
  direction: 'outbound',
  maps: { technology: 'expected answers' },
  portVersion: PORT_VERSIONS.EvaluatorPort,
  tiers: ['prototype', 'production'],
  description: 'Scores 1 or 0 by comparing a run output with the expected answer of the dataset case.',
  optionsSchema: {
    type: 'object',
    properties: {
      mode: { enum: ['contains', 'equals', 'regex'] },
      caseSensitive: { type: 'boolean' },
      metric: { type: 'string', minLength: 1 },
      layer: { enum: LAYERS.map((l) => l.layer) },
      ...limitProperties(LIMITS, { maxQuoteChars: 'Characters of an expected answer quoted in a score reason' }),
    },
    additionalProperties: false,
  },
  limits: LIMITS,
  create: (options, ctx) => createExpectedEval(options, ctx.name),
});

export const adapters = [adapter];
