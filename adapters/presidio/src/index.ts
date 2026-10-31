import { CORE_VOCABULARIES, createMappings, defineAdapter, GUARD_STAGES, limitProperties, limitValue, PORT_VERSIONS, type GuardPort, type GuardStage, type GuardVerdict, type LimitValue, type MappingRule, type Mappings, type Vocabularies } from '@agent-layers/core';
import { assertPlainUrl, failure, InvalidResponseError, postJson, trimSlash, type FetchLike, type HttpOptions } from './http.ts';
import { LIMITS } from './limits.ts';

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
  timeoutMs?: LimitValue;
  /** Largest response body read, in bytes (default 1048576); a larger one counts as a failure (`onError`). */
  maxResponseBytes?: LimitValue;
}

export interface PresidioDeps {
  fetch?: FetchLike;
  name?: string;
  /** Entity types → labels (`in` rules on the GuardVerdict, source `{ entities }`). Default: `LABEL_RULES`. */
  mappings?: Mappings;
  /** The stack's vocabularies, read at each check: labels it does not know become `other`. Default: core values. */
  vocabularies?: () => Vocabularies | undefined;
}

interface Finding { entity_type: string; start: number; end: number; score: number }

/** Entity types found, as `ext["presidio.entities"]`. */
export const ENTITIES_KEY = 'presidio.entities';

/** Set when the label mapping failed on a detection: the verdict stands, labelled `other`. */
export const MAPPING_ERROR_KEY = 'presidio.mappingError';

/** Presidio's predefined entity types, all personal data. */
const PII_ENTITIES = [
  'PERSON', 'EMAIL_ADDRESS', 'PHONE_NUMBER', 'CREDIT_CARD', 'IBAN_CODE', 'IP_ADDRESS', 'LOCATION', 'NRP', 'DATE_TIME',
  'MEDICAL_LICENSE', 'URL', 'CRYPTO', 'US_SSN', 'US_PASSPORT', 'US_DRIVER_LICENSE', 'US_ITIN', 'US_BANK_NUMBER', 'UK_NHS',
  'UK_NINO', 'ES_NIF', 'ES_NIE', 'IT_FISCAL_CODE', 'IT_DRIVER_LICENSE', 'IT_VAT_CODE', 'IT_PASSPORT', 'IT_IDENTITY_CARD',
  'PL_PESEL', 'SG_NRIC_FIN', 'SG_UEN', 'AU_ABN', 'AU_ACN', 'AU_TFN', 'AU_MEDICARE', 'IN_PAN', 'IN_AADHAAR',
  'IN_VEHICLE_REGISTRATION', 'IN_VOTER', 'IN_PASSPORT', 'FI_PERSONAL_IDENTITY_CODE',
];

/**
 * Default entity type → label rules, replaceable through the stack's `mappings.guardrails.<name>.in`. Unlisted types
 * (custom recognizers) are `other`.
 */
export const LABEL_RULES: readonly MappingRule[] = Object.freeze([
  { from: '/entities', to: '/labels', map: { ...Object.fromEntries(PII_ENTITIES.map((e) => [e, 'pii'])), '*': 'other' } },
]);

/** Entity types fit for a reason and `ext`: identifier-like names only, deduplicated, at most 64. */
const entityTypes = (found: readonly Finding[]) =>
  [...new Set(found.map((f) => f.entity_type))].filter((t) => typeof t === 'string' && /^[\w.-]{1,64}$/.test(t)).slice(0, 64);

/** Labels of a mapped verdict: known values of the vocabulary (unknown ones become `other`), deduplicated. */
function labelsOf(value: unknown, vocab: Vocabularies): GuardVerdict['labels'] {
  if (!Array.isArray(value)) return undefined;
  const out = [...new Set(value.map((l) => vocab.accept('guardLabel', l)).filter((l): l is string => !!l))];
  return out.length ? out : undefined;
}

/** Factory: PII detection with the Presidio analyzer, rewriting with the anonymizer. */
export function createPresidioGuard(options: PresidioOptions, deps: PresidioDeps = {}): GuardPort {
  const action = options.action ?? 'redact';
  if (action === 'redact' && !options.anonymizerUrl) throw new Error('presidio: action "redact" needs anonymizerUrl');
  assertPlainUrl(options.analyzerUrl, 'presidio analyzerUrl');
  if (options.anonymizerUrl) assertPlainUrl(options.anonymizerUrl, 'presidio anonymizerUrl');
  const name = deps.name ?? 'presidio';
  const mappings = deps.mappings ?? createMappings(`guardrails.${name}`, { in: LABEL_RULES });
  const vocab = (): Vocabularies => {
    try { return deps.vocabularies?.() ?? CORE_VOCABULARIES; } catch { return CORE_VOCABULARIES; }
  };
  const analyzer = `${trimSlash(options.analyzerUrl)}/analyze`;
  const anonymizer = options.anonymizerUrl ? `${trimSlash(options.anonymizerUrl)}/anonymize` : undefined;
  const http: HttpOptions = {
    timeoutMs: limitValue(LIMITS.timeoutMs, options.timeoutMs),
    maxResponseBytes: limitValue(LIMITS.maxResponseBytes, options.maxResponseBytes),
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
    const types = entityTypes(findings);
    /**
     * The verdict with labels from the entity types (through the mappings) and the types under `ext`. A failing
     * mapping never weakens the verdict: it stays, labelled `other`, with the failure noted under `ext`.
     */
    const described = (verdict: GuardVerdict): GuardVerdict => {
      const entities = types.length ? { [ENTITIES_KEY]: types } : {};
      let labels: GuardVerdict['labels'];
      try {
        labels = labelsOf((mappings.in({ entities: types }, verdict) as GuardVerdict | undefined)?.labels, vocab());
      } catch {
        return { ...verdict, labels: ['other'], ext: { ...entities, [MAPPING_ERROR_KEY]: 'label mapping failed' } };
      }
      return { ...verdict, ...(labels ? { labels } : {}), ...(types.length ? { ext: entities } : {}) };
    };
    if (action === 'block') return described({ action: 'block', reason: `PII detected: ${types.join(', ')}` });
    let redacted: string;
    try {
      const res = await postJson(anonymizer!, {
        text,
        analyzer_results: findings.map(({ entity_type, start, end, score }) => ({ entity_type, start, end, score })),
        ...(options.operators ? { anonymizers: options.operators } : {}),
      }, 'presidio anonymizer', http, signal) as { text?: unknown } | null;
      if (typeof res?.text !== 'string') throw new InvalidResponseError('presidio anonymizer');
      redacted = res.text;
    } catch (err) {
      if (signal?.aborted) throw err;
      // A detection is never downgraded to allow: when the anonymizer fails, the text is blocked whatever `onError` says.
      return described({ action: 'block', reason: `PII detected: ${types.join(', ')}; presidio anonymizer unavailable: ${failure(err)}` });
    }
    return described({ action: 'redact', text: redacted, reason: `PII redacted: ${types.join(', ')}` });
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
        // Only an analyzer that is unavailable or misbehaving reaches here, before anything was detected: label mapping
        // and anonymizer failures after a detection are handled in `inspect`.
        if ((options.onError ?? 'block') === 'allow') return { action: 'allow' };
        return { action: 'block', reason: `presidio unavailable: ${failure(err)}` };
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
      ...limitProperties(LIMITS, { timeoutMs: 'Time limit per request', maxResponseBytes: 'Largest response body read; a larger one counts as a failure' }),
    },
    required: ['analyzerUrl'],
    additionalProperties: false,
  },
  limits: LIMITS,
  ext: { produces: [ENTITIES_KEY, MAPPING_ERROR_KEY] },
  mappingDefaults: { in: { shape: 'GuardVerdict', rules: LABEL_RULES } },
  create: (options, ctx) => createPresidioGuard(options, { name: ctx.name, mappings: ctx.mappings, ...(ctx.stack ? { vocabularies: () => ctx.stack?.().vocabularies } : {}) }),
});

export const adapters = [adapter];
