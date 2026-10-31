import { CORE_VOCABULARIES, defineAdapter, GUARD_STAGES, limitProperties, limitValue, PORT_VERSIONS, type GuardCheck, type GuardPort, type GuardStage, type GuardVerdict, type LimitValue, type Vocabularies } from '@agent-layers/core';
import { assertPlainUrl, failure, InvalidResponseError, postJson, type FetchLike, type HttpOptions } from './http.ts';
import { LIMITS } from './limits.ts';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface HttpGuardOptions {
  /** Endpoint that receives `POST <GuardCheck>` and answers a `GuardVerdict`. */
  url: string;
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  headers?: Record<string, string>;
  /** Stages the guard runs at (default all). */
  stages?: GuardStage[];
  /** When the service cannot be reached or answers badly: `block` (default, fail closed) or `allow`. */
  onError?: 'block' | 'allow';
  /** Per-request timeout in milliseconds (default 10000). */
  timeoutMs?: LimitValue;
  /** Largest response body read, in bytes (default 1048576); a larger one counts as a failure (`onError`). */
  maxResponseBytes?: LimitValue;
}

export interface HttpGuardDeps {
  fetch?: FetchLike;
  name?: string;
  /** The stack's vocabularies, read at each check: labels it does not know become `other`. Default: core values. */
  vocabularies?: () => Vocabularies | undefined;
}

/** Labels the service answered that the vocabulary does not know, kept as they were sent. */
export const LABELS_KEY = 'http-guard.labels';

const ACTIONS: ReadonlySet<string> = new Set(['allow', 'block', 'redact']);
const MAX_LABELS = 64;

/**
 * Throws unless `value` is a GuardVerdict; returns it without unknown fields (an `ext` the service sent included).
 * `labels`, when present, must be a list of at most 64 strings; values the vocabulary does not know become `other`,
 * and the identifier-like ones among them are kept under `ext["http-guard.labels"]`.
 */
export function parseVerdict(value: unknown, vocab: Vocabularies = CORE_VOCABULARIES): GuardVerdict {
  const v = value as Partial<GuardVerdict> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v) || !ACTIONS.has(v.action as string)) throw new InvalidResponseError('guard service');
  if (v.action === 'redact' && typeof v.text !== 'string') throw new InvalidResponseError('guard service');
  let labels: string[] = [];
  const unknown: string[] = [];
  if (v.labels !== undefined) {
    if (!Array.isArray(v.labels) || v.labels.length > MAX_LABELS || v.labels.some((l) => typeof l !== 'string')) throw new InvalidResponseError('guard service');
    for (const l of v.labels) {
      if (vocab.has('guardLabel', l)) labels.push(vocab.resolve('guardLabel', l));
      else {
        labels.push('other');
        if (/^[\w.:-]{1,64}$/.test(l)) unknown.push(l);
      }
    }
    labels = [...new Set(labels)];
  }
  return {
    action: v.action!,
    ...(typeof v.text === 'string' ? { text: v.text } : {}),
    ...(labels.length ? { labels } : {}),
    ...(typeof v.reason === 'string' ? { reason: v.reason } : {}),
    ...(unknown.length ? { ext: { [LABELS_KEY]: [...new Set(unknown)] } } : {}),
  };
}

/** The request body: exactly the GuardCheck fields, and never a credential. */
function requestBody(check: GuardCheck): GuardCheck {
  const { caller, ...rest } = check;
  if (!caller) return { ...rest };
  const { credential: _credential, ...publicCaller } = caller as typeof caller & { credential?: string };
  return { ...rest, caller: publicCaller };
}

/** Factory: a guard backed by any HTTP service that speaks the guard contract. */
export function createHttpGuard(options: HttpGuardOptions, deps: HttpGuardDeps = {}): GuardPort {
  const vocab = (): Vocabularies => {
    try { return deps.vocabularies?.() ?? CORE_VOCABULARIES; } catch { return CORE_VOCABULARIES; }
  };
  assertPlainUrl(options.url, 'http-guard url');
  const http: HttpOptions = {
    timeoutMs: limitValue(LIMITS.timeoutMs, options.timeoutMs),
    maxResponseBytes: limitValue(LIMITS.maxResponseBytes, options.maxResponseBytes),
    headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
  return {
    name: deps.name ?? 'http-guard',
    ...(options.stages ? { stages: [...options.stages] } : {}),
    async check(input, opts) {
      try {
        return parseVerdict(await postJson(options.url, requestBody(input), 'guard service', http, opts?.signal), vocab());
      } catch (err) {
        if (opts?.signal?.aborted) throw err;
        return (options.onError ?? 'block') === 'allow' ? { action: 'allow' } : { action: 'block', reason: `guard service unavailable: ${failure(err)}` };
      }
    },
  };
}

export const adapter = defineAdapter<'GuardPort', HttpGuardOptions>({
  layer: 'guardrail',
  port: 'GuardPort',
  name: 'http-guard',
  direction: 'outbound',
  maps: { standard: 'agent-layers guard HTTP contract' },
  portVersion: PORT_VERSIONS.GuardPort,
  tiers: ['prototype', 'production'],
  description: 'Sends each check to an HTTP service as a GuardCheck and applies the GuardVerdict it answers.',
  optionsSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1 },
      token: { type: 'string' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      stages: { type: 'array', minItems: 1, items: { enum: [...GUARD_STAGES] } },
      onError: { enum: ['block', 'allow'] },
      ...limitProperties(LIMITS, { timeoutMs: 'Time limit per request', maxResponseBytes: 'Largest response body read; a larger one counts as a failure' }),
    },
    required: ['url'],
    additionalProperties: false,
  },
  limits: LIMITS,
  ext: { produces: [LABELS_KEY] },
  create: (options, ctx) => createHttpGuard(options, { name: ctx.name, ...(ctx.stack ? { vocabularies: () => ctx.stack?.().vocabularies } : {}) }),
});

export const adapters = [adapter];
