import { defineAdapter, GUARD_STAGES, PORT_VERSIONS, type GuardInput, type GuardPort, type GuardStage, type GuardVerdict } from '@agent-layers/core';
import { assertPlainUrl, failure, InvalidResponseError, postJson, type FetchLike, type HttpOptions } from './http.ts';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface HttpGuardOptions {
  /** Endpoint that receives `POST <GuardInput>` and answers a `GuardVerdict`. */
  url: string;
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  headers?: Record<string, string>;
  /** Stages the guard runs at (default all). */
  stages?: GuardStage[];
  /** When the service cannot be reached or answers badly: `block` (default, fail closed) or `allow`. */
  onError?: 'block' | 'allow';
  /** Per-request timeout in milliseconds (default 10000). */
  timeoutMs?: number;
}

export interface HttpGuardDeps { fetch?: FetchLike; name?: string }

const ACTIONS: ReadonlySet<string> = new Set(['allow', 'block', 'redact']);

/** Throws unless `value` is a GuardVerdict; returns it without unknown fields. */
export function parseVerdict(value: unknown): GuardVerdict {
  const v = value as Partial<GuardVerdict> | null;
  if (!v || typeof v !== 'object' || !ACTIONS.has(v.action as string)) throw new InvalidResponseError('guard service');
  if (v.action === 'redact' && typeof v.text !== 'string') throw new InvalidResponseError('guard service');
  return {
    action: v.action!,
    ...(typeof v.text === 'string' ? { text: v.text } : {}),
    ...(typeof v.reason === 'string' ? { reason: v.reason } : {}),
  };
}

/** The request body: exactly the GuardInput fields, and never a token. */
function requestBody(input: GuardInput): GuardInput {
  const { subject, ...rest } = input;
  if (!subject) return { ...rest };
  const { token: _token, ...publicSubject } = subject as typeof subject & { token?: string };
  return { ...rest, subject: publicSubject };
}

/** Factory: a guard backed by any HTTP service that speaks the guard contract. */
export function createHttpGuard(options: HttpGuardOptions, deps: HttpGuardDeps = {}): GuardPort {
  assertPlainUrl(options.url, 'http-guard url');
  const http: HttpOptions = {
    timeoutMs: options.timeoutMs ?? 10_000,
    headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
  return {
    name: deps.name ?? 'http-guard',
    ...(options.stages ? { stages: [...options.stages] } : {}),
    async check(input, opts) {
      try {
        return parseVerdict(await postJson(options.url, requestBody(input), 'guard service', http, opts?.signal));
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
  description: 'Sends each check to an HTTP service as a GuardInput and applies the GuardVerdict it answers.',
  optionsSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1 },
      token: { type: 'string' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      stages: { type: 'array', minItems: 1, items: { enum: [...GUARD_STAGES] } },
      onError: { enum: ['block', 'allow'] },
      timeoutMs: { type: 'integer', minimum: 1 },
    },
    required: ['url'],
    additionalProperties: false,
  },
  create: (options, ctx) => createHttpGuard(options, { name: ctx.name }),
});

export const adapters = [adapter];
