import { defineAdapter, GUARD_STAGES, PORT_VERSIONS, type GuardPort, type GuardStage, type GuardVerdict } from '@agent-layers/core';
import { assertPlainUrl, failure, InvalidResponseError, postJson, trimSlash, type FetchLike, type HttpOptions } from './http.ts';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface PresidioOptions {
  /** Presidio Analyzer base URL (`POST /analyze`). */
  analyzerUrl: string;
  /** Presidio Anonymizer base URL (`POST /anonymize`); used only when `action` is `redact`. */
  anonymizerUrl?: string;
  /** What to do with text that has findings (default `redact`). */
  action?: 'redact' | 'block';
  /** Language of the text (default `en`). */
  language?: string;
  /** Entity types to look for (default: everything the analyzer supports). */
  entities?: string[];
  /** Ignore findings scored below this, 0 to 1. */
  scoreThreshold?: number;
  /** Anonymizer operators per entity type, `DEFAULT` for the rest, e.g. `{ "DEFAULT": { "type": "replace", "new_value": "[PII]" } }`. */
  operators?: Record<string, unknown>;
  /** Stages the guard runs at (default all). */
  stages?: GuardStage[];
  /** When Presidio cannot be reached or answers badly: `block` (default, fail closed) or `allow`. */
  onError?: 'block' | 'allow';
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds (default 10000). */
  timeoutMs?: number;
}

export interface PresidioDeps { fetch?: FetchLike; name?: string }

interface Finding { entity_type: string; start: number; end: number; score: number }

const entityTypes = (found: readonly Finding[]) => [...new Set(found.map((f) => f.entity_type))].join(', ');

/** Factory: PII detection with the Presidio analyzer, rewriting with the anonymizer. */
export function createPresidioGuard(options: PresidioOptions, deps: PresidioDeps = {}): GuardPort {
  const action = options.action ?? 'redact';
  if (action === 'redact' && !options.anonymizerUrl) throw new Error('presidio: action "redact" needs anonymizerUrl');
  assertPlainUrl(options.analyzerUrl, 'presidio analyzerUrl');
  if (options.anonymizerUrl) assertPlainUrl(options.anonymizerUrl, 'presidio anonymizerUrl');
  const name = deps.name ?? 'presidio';
  const analyzer = `${trimSlash(options.analyzerUrl)}/analyze`;
  const anonymizer = options.anonymizerUrl ? `${trimSlash(options.anonymizerUrl)}/anonymize` : undefined;
  const http: HttpOptions = {
    timeoutMs: options.timeoutMs ?? 10_000,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };

  async function inspect(text: string, signal: AbortSignal | undefined): Promise<GuardVerdict> {
    const found = await postJson(analyzer, {
      text,
      language: options.language ?? 'en',
      ...(options.entities ? { entities: options.entities } : {}),
      ...(options.scoreThreshold !== undefined ? { score_threshold: options.scoreThreshold } : {}),
    }, 'presidio analyzer', http, signal);
    if (!Array.isArray(found)) throw new InvalidResponseError('presidio analyzer');
    const findings = found as Finding[];
    if (!findings.length) return { action: 'allow' };
    if (action === 'block') return { action: 'block', reason: `PII detected: ${entityTypes(findings)}` };
    const res = await postJson(anonymizer!, {
      text,
      analyzer_results: findings.map(({ entity_type, start, end, score }) => ({ entity_type, start, end, score })),
      ...(options.operators ? { anonymizers: options.operators } : {}),
    }, 'presidio anonymizer', http, signal) as { text?: unknown } | null;
    if (typeof res?.text !== 'string') throw new InvalidResponseError('presidio anonymizer');
    return { action: 'redact', text: res.text, reason: `PII redacted: ${entityTypes(findings)}` };
  }

  return {
    name,
    ...(options.stages ? { stages: [...options.stages] } : {}),
    native: () => ({ analyzer, anonymizer }),
    async check({ text }, opts) {
      if (!text.trim()) return { action: 'allow' };
      try {
        return await inspect(text, opts?.signal);
      } catch (err) {
        if (opts?.signal?.aborted) throw err;
        return (options.onError ?? 'block') === 'allow' ? { action: 'allow' } : { action: 'block', reason: `presidio unavailable: ${failure(err)}` };
      }
    },
  };
}

export const adapter = defineAdapter<'GuardPort', PresidioOptions>({
  layer: 'guardrail',
  port: 'GuardPort',
  name: 'presidio',
  direction: 'outbound',
  maps: { technology: 'Microsoft Presidio' },
  portVersion: PORT_VERSIONS.GuardPort,
  tiers: ['prototype', 'production'],
  description: 'Detects PII with the Presidio analyzer and redacts it with the anonymizer, or blocks the text.',
  optionsSchema: {
    type: 'object',
    properties: {
      analyzerUrl: { type: 'string', minLength: 1 },
      anonymizerUrl: { type: 'string', minLength: 1 },
      action: { enum: ['redact', 'block'] },
      language: { type: 'string', minLength: 2 },
      entities: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      scoreThreshold: { type: 'number', minimum: 0, maximum: 1 },
      operators: { type: 'object' },
      stages: { type: 'array', minItems: 1, items: { enum: [...GUARD_STAGES] } },
      onError: { enum: ['block', 'allow'] },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      timeoutMs: { type: 'integer', minimum: 1 },
    },
    required: ['analyzerUrl'],
    additionalProperties: false,
  },
  create: (options, ctx) => createPresidioGuard(options, { name: ctx.name }),
});

export const adapters = [adapter];
