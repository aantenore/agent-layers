import { defineAdapter, PORT_VERSIONS, type CachePort } from '@agent-layers/core';

export interface MemoryCacheOptions {
  /** Entries kept before the least recently used one is evicted. */
  maxEntries?: number;
  /** Default time to live; a per-call `ttlMs` overrides it. No expiry when unset. */
  ttlMs?: number;
}

interface Entry { value: unknown; expiresAt: number | undefined }

/** Cache backed by a Map with LRU eviction. Values are copied on the way in and out. */
export function createMemoryCache(options: MemoryCacheOptions = {}, name = 'memory-cache'): CachePort {
  const maxEntries = options.maxEntries ?? 1000;
  const entries = new Map<string, Entry>();
  return {
    name,
    native: () => entries,
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return structuredClone(entry.value);
    },
    async set(key, value, opts) {
      const ttl = opts?.ttlMs ?? options.ttlMs;
      entries.delete(key);
      entries.set(key, { value: structuredClone(value), expiresAt: ttl === undefined ? undefined : Date.now() + ttl });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
    },
    async delete(key) {
      entries.delete(key);
    },
    async close() {
      entries.clear();
    },
  };
}

export const adapter = defineAdapter<'CachePort', MemoryCacheOptions>({
  layer: 'cache',
  port: 'CachePort',
  name: 'memory-cache',
  direction: 'outbound',
  maps: { technology: 'in-process Map' },
  portVersion: PORT_VERSIONS.CachePort,
  tiers: ['prototype'],
  description: 'In-process LRU cache with optional expiry. Lost on restart; for development and demos.',
  optionsSchema: {
    type: 'object',
    properties: {
      maxEntries: { type: 'integer', minimum: 1 },
      ttlMs: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  },
  create: (options, ctx) => createMemoryCache(options, ctx.name),
});

export const adapters = [adapter];
