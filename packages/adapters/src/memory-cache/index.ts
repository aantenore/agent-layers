import { defineAdapter, defineLimits, limitProperties, limitValue, PORT_VERSIONS, type CachePort, type LimitValue } from '@agent-layers/core';

export interface MemoryCacheOptions {
  /** Entries kept before the least recently used one is evicted (default 1000). */
  maxEntries?: LimitValue;
  /** Default time to live; a per-call `ttlMs` overrides it. No expiry when unset. */
  ttlMs?: LimitValue;
}

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  maxEntries: { path: 'options.maxEntries', default: 1000, unit: 'count', min: 1, unbounded: 'fail', safe: { max: 100_000 } },
  ttlMs: { path: 'options.ttlMs', default: 'unbounded', unit: 'ms', min: 1, unbounded: 'warn' },
});

interface Entry { value: unknown; expiresAt: number | undefined }

/** Cache backed by a Map with LRU eviction. Values are copied on the way in and out. */
export function createMemoryCache(options: MemoryCacheOptions = {}, name = 'memory-cache'): CachePort {
  const maxEntries = limitValue(LIMITS.maxEntries, options.maxEntries);
  const defaultTtl = limitValue(LIMITS.ttlMs, options.ttlMs);
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
      const ttl = opts?.ttlMs ?? defaultTtl;
      entries.delete(key);
      entries.set(key, { value: structuredClone(value), expiresAt: Number.isFinite(ttl) ? Date.now() + ttl : undefined });
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
      ...limitProperties(LIMITS, {
        maxEntries: 'Entries kept before the least recently used one is evicted',
        ttlMs: 'Default time to live; a per-call ttlMs overrides it',
      }),
    },
    additionalProperties: false,
  },
  limits: LIMITS,
  create: (options, ctx) => createMemoryCache(options, ctx.name),
});

export const adapters = [adapter];
