import { createHash } from 'node:crypto';
import { defineAdapter, PORT_VERSIONS, type KnowledgePort, type Passage } from '@agent-layers/core';
import { interpolate } from './env.ts';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface HttpKnowledgeOptions {
  /** Endpoint that accepts `POST {query, k, filter}` and answers `{passages}`. */
  url: string;
  /** Static headers, for example an API key. `${env:NAME}` is resolved when the source is built. */
  headers?: Record<string, string>;
  /** Send the caller's raw token (`identity.token`) as `Authorization: Bearer`, so the service can apply its own access rules. */
  forwardIdentityToken?: boolean;
  /** Time limit per request (default 10000). */
  timeoutMs?: number;
  /** Passages requested when the query has no `k` (default 4). */
  k?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_K = 4;
const ERROR_BODY_CHARS = 300;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hashId = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 12);

/** Keeps the Passage fields; an item without text is dropped, a missing id is derived from the text. */
function toPassage(raw: unknown, source: string): Passage | undefined {
  if (!isRecord(raw) || typeof raw.text !== 'string' || !raw.text.trim()) return undefined;
  const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : hashId(raw.text);
  return {
    id,
    text: raw.text,
    source: typeof raw.source === 'string' ? raw.source : source,
    ...(typeof raw.score === 'number' ? { score: raw.score } : {}),
    ...(isRecord(raw.metadata) ? { metadata: raw.metadata } : {}),
  };
}

/** Factory: usable directly from code, without the registry. */
export function createHttpKnowledge(
  options: HttpKnowledgeOptions,
  { name, env = process.env }: { name?: string; env?: Record<string, string | undefined> } = {},
): KnowledgePort {
  const url = interpolate(options.url, env, 'url');
  if (!/^https?:\/\//i.test(url)) throw new Error('http-knowledge: url must be absolute http(s)');
  const headers = interpolate(options.headers ?? {}, env, 'headers');
  const source = name ?? new URL(url).host;
  return {
    name: source,
    async search(q) {
      const k = q.k ?? options.k ?? DEFAULT_K;
      const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...headers,
          ...(options.forwardIdentityToken && q.identity?.token ? { authorization: `Bearer ${q.identity.token}` } : {}),
        },
        body: JSON.stringify({ query: q.query, k, ...(q.filter ? { filter: q.filter } : {}) }),
        signal: q.signal ? AbortSignal.any([q.signal, timeout]) : timeout,
      });
      if (!res.ok) throw new Error(`knowledge HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, ERROR_BODY_CHARS)}`);
      const body: unknown = await res.json().catch(() => undefined);
      if (!isRecord(body) || !Array.isArray(body.passages)) throw new Error('knowledge HTTP: response has no "passages" array');
      return body.passages.flatMap((p) => toPassage(p, source) ?? []).slice(0, Math.max(0, k));
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
      forwardIdentityToken: { type: 'boolean' },
      timeoutMs: { type: 'integer', minimum: 1 },
      k: { type: 'integer', minimum: 1 },
    },
    required: ['url'],
    additionalProperties: false,
  },
  create: (options, ctx) => createHttpKnowledge(options, { name: ctx.name, env: ctx.env }),
});

export const adapters = [adapter];
