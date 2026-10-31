import { CORE_VOCABULARIES, createMappings, defineAdapter, GUARD_STAGES, limitProperties, limitValue, MappingError, PORT_VERSIONS, type GuardPort, type GuardStage, type GuardVerdict, type LimitValue, type MappingRule, type Mappings, type Vocabularies } from '@agent-layers/core';
import { assertPlainUrl, failure, HttpStatusError, InvalidResponseError, postJson, trimSlash, type FetchLike, type HttpOptions } from './http.ts';
import { LIMITS } from './limits.ts';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface LlmGuardOptions {
  /** LLM Guard API base URL (`POST /analyze/prompt`, `POST /analyze/output`). */
  url: string;
  /** Bearer token (the API's `AUTH_TOKEN`); omit when authentication is off. */
  token?: string;
  /** Scanner class names to skip on every call, e.g. `["Toxicity"]`. */
  scannersSuppress?: string[];
  /**
   * Scanners that repair the text instead of rejecting it, such as `Secrets` or `Anonymize`: they report the verdict as
   * invalid but return sanitized text. When only these fail, the sanitized text is applied (redact) instead of blocking.
   */
  sanitizeScanners?: string[];
  /** Stages the guard runs at (default `input`, `output`, `tool_result`). */
  stages?: GuardStage[];
  /** When LLM Guard cannot be reached or answers badly: `block` (default, fail closed) or `allow`. */
  onError?: 'block' | 'allow';
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds (default 30000: scanners run models). */
  timeoutMs?: LimitValue;
  /** Largest response body read, in bytes (default 1048576); a larger one counts as a failure (`onError`). */
  maxResponseBytes?: LimitValue;
}

export interface LlmGuardDeps {
  fetch?: FetchLike;
  name?: string;
  /** Scanner names → labels (`in` rules on the GuardVerdict, source `{ scanners }`). Default: `LABEL_RULES`. */
  mappings?: Mappings;
  /** The stack's vocabularies, read at each check: labels it does not know become `other`. Default: core values. */
  vocabularies?: () => Vocabularies | undefined;
}

/** Names of the scanners that decided a verdict, as `ext["llm-guard.scanners"]`. */
export const SCANNERS_KEY = 'llm-guard.scanners';

/**
 * Default scanner → label rules (LLM Guard's prompt and output scanners), replaceable through the stack's
 * `mappings.guardrails.<name>.in`. Unlisted scanners are `other`.
 */
export const LABEL_RULES: readonly MappingRule[] = Object.freeze([{
  from: '/scanners', to: '/labels', map: {
    PromptInjection: 'injection', Secrets: 'secret', Anonymize: 'pii', Sensitive: 'pii', Toxicity: 'toxicity',
    BanTopics: 'policy', BanSubstrings: 'policy', BanCompetitors: 'policy', BanCode: 'policy', Code: 'policy', Regex: 'policy',
    InvisibleText: 'injection', MaliciousURLs: 'policy', '*': 'other',
  },
}]);

/** Labels of a mapped verdict: known values of the vocabulary (unknown ones become `other`), deduplicated. */
function labelsOf(value: unknown, vocab: Vocabularies): GuardVerdict['labels'] {
  if (!Array.isArray(value)) return undefined;
  const out = [...new Set(value.map((l) => vocab.accept('guardLabel', l)).filter((l): l is string => !!l))];
  return out.length ? out : undefined;
}

interface Analysis { is_valid?: unknown; scanners?: unknown; sanitized_prompt?: unknown; sanitized_output?: unknown }

/**
 * Scanners that failed. A passing scanner reports a risk score of -1; a failing one 0 or more. When none qualifies,
 * every scanner is named so the reason is never empty.
 */
function failingScanners(scanners: unknown): string[] {
  const entries = Object.entries((scanners && typeof scanners === 'object' ? scanners : {}) as Record<string, unknown>);
  // Names come from the service and end up in a reason: keep only identifier-like ones.
  const names = (list: [string, unknown][]) => list.map(([name]) => name).filter((n) => /^[\w.-]{1,64}$/.test(n)).slice(0, 64);
  const failing = names(entries.filter(([, score]) => typeof score === 'number' && score >= 0));
  return failing.length ? failing : names(entries);
}

/**
 * Factory: LLM Guard over its REST API. `output` goes through the output scanners (`/analyze/output`, which requires
 * a `prompt` field: the guard has none, so it sends an empty one); every other stage goes through the prompt scanners.
 * An invalid verdict blocks and names the failing scanners; a valid one whose sanitized text differs redacts.
 */
export function createLlmGuard(options: LlmGuardOptions, deps: LlmGuardDeps = {}): GuardPort {
  assertPlainUrl(options.url, 'llm-guard url');
  const base = trimSlash(options.url);
  const http: HttpOptions = {
    timeoutMs: limitValue(LIMITS.timeoutMs, options.timeoutMs),
    maxResponseBytes: limitValue(LIMITS.maxResponseBytes, options.maxResponseBytes),
    headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
  const name = deps.name ?? 'llm-guard';
  const mappings = deps.mappings ?? createMappings(`guardrails.${name}`, { in: LABEL_RULES });
  const vocab = (): Vocabularies => {
    try { return deps.vocabularies?.() ?? CORE_VOCABULARIES; } catch { return CORE_VOCABULARIES; }
  };
  /** The verdict with labels from the scanner names (through the mappings) and the names under `ext`. */
  const described = (verdict: GuardVerdict, scanners: string[]): GuardVerdict => {
    if (!scanners.length) return verdict;
    const labels = labelsOf((mappings.in({ scanners }, verdict) as GuardVerdict | undefined)?.labels, vocab());
    return { ...verdict, ...(labels ? { labels } : {}), ext: { [SCANNERS_KEY]: scanners } };
  };
  const repairing = new Set(options.sanitizeScanners);
  const suppress = options.scannersSuppress?.length ? { scanners_suppress: options.scannersSuppress } : {};

  async function inspect(stage: GuardStage, text: string, signal: AbortSignal | undefined): Promise<GuardVerdict> {
    const output = stage === 'output';
    const res = await postJson(
      `${base}/analyze/${output ? 'output' : 'prompt'}`,
      output ? { prompt: '', output: text, ...suppress } : { prompt: text, ...suppress },
      'llm-guard', http, signal,
    ) as Analysis | null;
    if (typeof res?.is_valid !== 'boolean') throw new InvalidResponseError('llm-guard');
    const sanitized = output ? res.sanitized_output : res.sanitized_prompt;
    if (!res.is_valid) {
      const failed = failingScanners(res.scanners);
      if (failed.length && failed.every((n) => repairing.has(n)) && typeof sanitized === 'string' && sanitized !== text) {
        return described({ action: 'redact', text: sanitized, reason: `llm-guard: sanitized (${failed.join(', ')})` }, failed);
      }
      return described({ action: 'block', reason: `llm-guard: ${failed.join(', ') || 'invalid'}` }, failed);
    }
    return typeof sanitized === 'string' && sanitized !== text ? { action: 'redact', text: sanitized, reason: 'llm-guard: sanitized' } : { action: 'allow' };
  }

  return {
    name,
    stages: [...(options.stages ?? ['input', 'output', 'tool_result'])],
    native: () => ({ url: base }),
    async check({ stage, text }, opts) {
      if (!text.trim()) return { action: 'allow' };
      try {
        return await inspect(stage, text, opts?.signal);
      } catch (err) {
        if (opts?.signal?.aborted) throw err;
        if ((options.onError ?? 'block') === 'allow') return { action: 'allow' };
        if (err instanceof MappingError) return { action: 'block', reason: 'llm-guard: label mapping failed' };
        const why = err instanceof HttpStatusError && (err.status === 401 || err.status === 403) ? `authentication failed (HTTP ${err.status})` : failure(err);
        return { action: 'block', reason: `llm-guard unavailable: ${why}` };
      }
    },
  };
}

export const adapter = defineAdapter<'GuardPort', LlmGuardOptions>({
  layer: 'guardrail',
  port: 'GuardPort',
  name: 'llm-guard',
  direction: 'outbound',
  maps: { technology: 'LLM Guard' },
  portVersion: PORT_VERSIONS.GuardPort,
  tiers: ['prototype', 'production'],
  description: 'Scans text with LLM Guard: blocks prompt injection and secrets, applies the sanitized text.',
  optionsSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1 },
      token: { type: 'string' },
      scannersSuppress: { type: 'array', items: { type: 'string', minLength: 1 } },
      sanitizeScanners: { type: 'array', items: { type: 'string', minLength: 1 } },
      stages: { type: 'array', minItems: 1, items: { enum: [...GUARD_STAGES] } },
      onError: { enum: ['block', 'allow'] },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      ...limitProperties(LIMITS, { timeoutMs: 'Time limit per request', maxResponseBytes: 'Largest response body read; a larger one counts as a failure' }),
    },
    required: ['url'],
    additionalProperties: false,
  },
  limits: LIMITS,
  ext: { produces: [SCANNERS_KEY] },
  mappingDefaults: { in: { shape: 'GuardVerdict', rules: LABEL_RULES } },
  create: (options, ctx) => createLlmGuard(options, { name: ctx.name, mappings: ctx.mappings, ...(ctx.stack ? { vocabularies: () => ctx.stack?.().vocabularies } : {}) }),
});

export const adapters = [adapter];
