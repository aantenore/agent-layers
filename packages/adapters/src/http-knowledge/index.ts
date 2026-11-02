import { createHash } from 'node:crypto';
import {
  anySignal, createMappings, defineAdapter, defineLimits, limitProperties, limitValue, PORT_VERSIONS, timeoutSignal, type Attrs, type KnowledgePort, type LimitValue,
  type Mappings, type MappingRule, type Passage,
} from '@agent-layers/core';
import { interpolate } from './env.ts';
import { headerSecrets, redact, secretForms } from './redact.ts';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface HttpKnowledgeOptions {
  /** Endpoint that accepts `POST {query, k, filter}` and answers `{passages}`. */
  url: string;
  /** Static headers, for example an API key. `${env:NAME}` is resolved when the source is built. */
  headers?: Record<string, string>;
  /** Send the caller's credential (`caller.credential`) as `Authorization: Bearer`, so the service can apply its own access rules. */
  forwardCallerCredential?: boolean;
  /** Time limit per request (default 10000). */
  timeoutMs?: LimitValue;
  /** Passages requested when the query has no `k` (default 4). */
  k?: number;
  /** Characters of an error body kept in the error message, after masking (default 300). */
  errorBodyChars?: number;
  /** Header values shorter than this are not masked in error bodies (default 4). */
  minSecretChars?: number;
}

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  timeoutMs: { path: 'options.timeoutMs', default: 10_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 120_000 } },
  k: { path: 'options.k', default: 4, unit: 'count', min: 1, safe: { max: 50 } },
  errorBodyChars: { path: 'options.errorBodyChars', default: 300, unit: 'chars', min: 0, max: 100_000, safe: { max: 2000 } },
  minSecretChars: { path: 'options.minSecretChars', default: 4, unit: 'chars', min: 1, max: 64, safe: { max: 8 } },
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hashId = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 12);
const isAttr = (v: unknown): v is Attrs[string] =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (Array.isArray(v) && v.every((x) => typeof x === 'string'));

/** Ext key for item metadata that is not a plain attribute (nested objects, mixed lists). */
const EXT_METADATA = 'http-knowledge.metadata';

/** Default `in` rule: the service's own `source` of an item is kept as an attribute (the passage source is the instance). */
export const DEFAULT_IN_RULES: readonly MappingRule[] = [{ from: '/source', to: '/attrs/source' }];

/**
 * Wire item → Passage. An item without text is dropped, a missing id is derived from the text. `attrs` (or the older
 * `metadata`) become `attrs`; values that are not plain attributes go to `ext["http-knowledge.metadata"]`. The `in`
 * mapping rules then run over the raw item.
 */
function toPassage(raw: unknown, source: string, mappings: Mappings): Passage | undefined {
  if (!isRecord(raw) || typeof raw.text !== 'string' || !raw.text.trim()) return undefined;
  const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : hashId(raw.text);
  const meta = isRecord(raw.attrs) ? raw.attrs : isRecord(raw.metadata) ? raw.metadata : undefined;
  const attrs: Attrs = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (isAttr(v)) attrs[k] = v;
    else if (v !== undefined) rest[k] = v;
  }
  return mappings.in(raw, {
    id,
    text: raw.text,
    source,
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
    ...(typeof raw.score === 'number' && Number.isFinite(raw.score) ? { score: raw.score } : {}),
    ...(Object.keys(attrs).length ? { attrs } : {}),
    ...(Object.keys(rest).length ? { ext: { [EXT_METADATA]: rest } } : {}),
  } as Passage);
}

/** Factory: usable directly from code, without the registry. */
export function createHttpKnowledge(
  options: HttpKnowledgeOptions,
  { name, env = process.env, mappings = createMappings(name ?? 'http-knowledge', { in: DEFAULT_IN_RULES }) }:
  { name?: string; env?: Record<string, string | undefined>; mappings?: Mappings } = {},
): KnowledgePort {
  const url = interpolate(options.url, env, 'url');
  if (!/^https?:\/\//i.test(url)) throw new Error('http-knowledge: url must be absolute http(s)');
  const headers = interpolate(options.headers ?? {}, env, 'headers');
  const source = name ?? new URL(url).host;
  const timeoutMs = limitValue(LIMITS.timeoutMs, options.timeoutMs);
  const errorBodyChars = limitValue(LIMITS.errorBodyChars, options.errorBodyChars);
  const minSecretChars = limitValue(LIMITS.minSecretChars, options.minSecretChars);
  return {
    name: source,
    async search(q) {
      const k = q.k ?? limitValue(LIMITS.k, options.k);
      const sent: Record<string, string> = {
        ...headers,
        ...(options.forwardCallerCredential && q.caller?.credential ? { authorization: `Bearer ${q.caller.credential}` } : {}),
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...sent },
        // The wire keeps its own field names: `query` is the language's `KnowledgeQuery.text`.
        body: JSON.stringify({ query: q.text, k, ...(q.filter ? { filter: q.filter } : {}) }),
        // Redirects are not followed: the query and the credentials stay with the configured host.
        redirect: 'manual',
        signal: anySignal(q.signal, timeoutSignal(timeoutMs)),
      });
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`knowledge HTTP: redirects are not followed (HTTP ${res.status})`);
      }
      // The error body may echo the credentials; mask the whole body before cutting it.
      if (!res.ok) throw new Error(`knowledge HTTP ${res.status}: ${redact(await res.text().catch(() => ''), secretForms(headerSecrets(sent), minSecretChars)).slice(0, errorBodyChars)}`);
      const body: unknown = await res.json().catch(() => undefined);
      if (!isRecord(body) || !Array.isArray(body.passages)) throw new Error('knowledge HTTP: response has no "passages" array');
      return body.passages.flatMap((p) => toPassage(p, source, mappings) ?? []).slice(0, Math.max(0, k));
    },
  };
}

/** Descriptor: what the registry and the CLI see. */
export const adapter = defineAdapter<'KnowledgePort', HttpKnowledgeOptions>({
  layer: 'knowledge',
  port: 'KnowledgePort',
  name: 'http-knowledge',
  direction: 'outbound',
  maps: { standard: 'agent-layers knowledge HTTP contract' },
  portVersion: PORT_VERSIONS.KnowledgePort,
  tiers: ['prototype', 'production'],
  description: 'Searches any service that answers POST {query, k, filter} with {passages}.',
  optionsSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1 },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      forwardCallerCredential: { type: 'boolean' },
      ...limitProperties(LIMITS, {
        timeoutMs: 'Time limit per query', k: 'Passages requested when the query has no k',
        errorBodyChars: 'Characters of an error body kept in the error message', minSecretChars: 'Shortest header value masked in error bodies',
      }),
    },
    required: ['url'],
    additionalProperties: false,
  },
  limits: LIMITS,
  ext: { produces: [EXT_METADATA] },
  mappingDefaults: { in: { shape: 'Passage', rules: DEFAULT_IN_RULES } },
  create: (options, ctx) => createHttpKnowledge(options, { name: ctx.name, env: ctx.env, mappings: ctx.mappings }),
});

export const adapters = [adapter];
