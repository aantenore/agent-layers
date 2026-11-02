import {
  AdapterError, defineAdapter, defineLimits, encodeStoreValue, limitProperties, limitValue, PORT_VERSIONS, storeKeyProblem, storeOptionsProblem,
  type JsonValue, type LimitValue, type StoreEntry, type StorePort,
} from '@agent-layers/core';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface MemoryStoreOptions {
  /** Keys kept; a write of a new key beyond this is refused once expired keys are dropped (default 10000). */
  maxKeys?: LimitValue;
  /** Longest key (default 512 characters). */
  maxKeyChars?: number;
  /** Largest value, as JSON in UTF-8 (default 65536 bytes). */
  maxValueBytes?: number;
  /** Most keys one `list` returns, and its default (default 100). */
  listLimit?: number;
}

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  maxKeys: { path: 'options.maxKeys', default: 10_000, unit: 'count', min: 1, unbounded: 'warn', safe: { max: 1_000_000 } },
  maxKeyChars: { path: 'options.maxKeyChars', default: 512, unit: 'chars', min: 16, max: 4096 },
  maxValueBytes: { path: 'options.maxValueBytes', default: 65_536, unit: 'bytes', min: 1024, max: 16_777_216, safe: { max: 1_048_576 } },
  listLimit: { path: 'options.listLimit', default: 100, unit: 'count', min: 1, max: 10_000 },
});

const ADAPTER = 'memory-store';

interface Entry { json: string; version: number; expiresAt: number | undefined }

/**
 * Key/value store kept in a Map. Values are stored as JSON text, so every read is a fresh copy. Versions come from one
 * counter for the whole store, so a key never gets a version it had before. Expired keys read as absent and are dropped
 * when touched or when the store is full.
 */
export function createMemoryStore(options: MemoryStoreOptions = {}, name = ADAPTER): StorePort {
  const maxKeys = limitValue(LIMITS.maxKeys, options.maxKeys);
  const maxKeyChars = limitValue(LIMITS.maxKeyChars, options.maxKeyChars);
  const maxValueBytes = limitValue(LIMITS.maxValueBytes, options.maxValueBytes);
  const listLimit = limitValue(LIMITS.listLimit, options.listLimit);
  const entries = new Map<string, Entry>();
  let counter = 0;

  const fail = (message: string) => new AdapterError('harness', ADAPTER, message);
  const checkKey = (key: string) => {
    const problem = storeKeyProblem(key, maxKeyChars);
    if (problem) throw fail(problem);
  };
  const live = (key: string): Entry | undefined => {
    const e = entries.get(key);
    if (e?.expiresAt !== undefined && e.expiresAt <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return e;
  };
  const entryOf = (e: Entry): StoreEntry => ({
    value: JSON.parse(e.json) as JsonValue, version: e.version, ...(e.expiresAt !== undefined ? { expiresAt: new Date(e.expiresAt).toISOString() } : {}),
  });
  const sweep = () => { for (const key of entries.keys()) live(key); };

  return {
    name,
    native: () => entries,
    async get(key) {
      checkKey(key);
      const e = live(key);
      return e && entryOf(e);
    },
    async set(key, value, opts = {}) {
      checkKey(key);
      const problem = storeOptionsProblem(opts);
      if (problem) throw fail(problem);
      const encoded = encodeStoreValue(value, maxValueBytes);
      if ('problem' in encoded) throw fail(encoded.problem);
      const current = live(key);
      if (opts.ifVersion !== undefined && (current?.version ?? 0) !== opts.ifVersion) return { ok: false, ...(current ? { version: current.version } : {}) };
      if (!current && entries.size >= maxKeys) {
        sweep();
        if (entries.size >= maxKeys) throw fail(`the store is full (${maxKeys} keys)`);
      }
      const version = ++counter;
      entries.set(key, { json: encoded.json, version, expiresAt: opts.ttlMs !== undefined ? Date.now() + opts.ttlMs : undefined });
      return { ok: true, version };
    },
    async delete(key, opts = {}) {
      checkKey(key);
      const problem = storeOptionsProblem({ ...(opts.ifVersion !== undefined ? { ifVersion: opts.ifVersion } : {}) });
      if (problem) throw fail(problem);
      const current = live(key);
      if (opts.ifVersion !== undefined && (current?.version ?? 0) !== opts.ifVersion) return { ok: false, ...(current ? { version: current.version } : {}) };
      entries.delete(key);
      return { ok: true, existed: !!current };
    },
    async list(prefix, opts = {}) {
      const limit = Math.min(listLimit, Math.max(0, Math.trunc(opts.limit ?? listLimit)));
      const keys = [...entries.keys()].filter((k) => k.startsWith(prefix) && (opts.after === undefined || k > opts.after)).sort();
      const out = [];
      for (const key of keys) {
        if (out.length >= limit) break;
        const e = live(key);
        if (e) out.push({ key, version: e.version, ...(e.expiresAt !== undefined ? { expiresAt: new Date(e.expiresAt).toISOString() } : {}) });
      }
      return out;
    },
    async close() {
      entries.clear();
    },
  };
}

export const adapter = defineAdapter<'StorePort', MemoryStoreOptions>({
  layer: 'harness',
  port: 'StorePort',
  name: ADAPTER,
  direction: 'outbound',
  maps: { technology: 'in-process Map' },
  portVersion: PORT_VERSIONS.StorePort,
  tiers: ['prototype'],
  description: 'Keeps small JSON values by key in memory, with versions for compare-and-set and expiry. Lost on restart; for development and tests.',
  optionsSchema: {
    type: 'object',
    properties: limitProperties(LIMITS, {
      maxKeys: 'Keys kept; a new key beyond this is refused once expired keys are dropped',
      maxKeyChars: 'Longest key',
      maxValueBytes: 'Largest value, as JSON in UTF-8',
      listLimit: 'Most keys one list returns, and its default',
    }),
    additionalProperties: false,
  },
  limits: LIMITS,
  create: (options, ctx) => createMemoryStore(options, ctx.name),
});

export const adapters = [adapter];
