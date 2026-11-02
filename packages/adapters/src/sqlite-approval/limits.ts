import { defineLimits } from '@agent-layers/core';

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  ttlMs: { path: 'options.ttlMs', default: 'unbounded', unit: 'ms', min: 1, unbounded: 'warn' },
  busyTimeoutMs: { path: 'options.busyTimeoutMs', default: 5000, unit: 'ms', min: 0, unbounded: 'fail', safe: { max: 60_000 } },
  pollMs: { path: 'options.pollMs', default: 500, unit: 'ms', min: 10, safe: { min: 100, max: 10_000 } },
  retainMs: { path: 'options.retainMs', default: 604_800_000, unit: 'ms', min: 1000, unbounded: 'warn' },
  listLimit: { path: 'options.listLimit', default: 100, unit: 'count', min: 1, max: 10_000 },
});

/** How often writes prune rows past `retainMs` (besides once on open). */
export const PRUNE_EVERY_MS = 60_000;

/** Largest wait SQLite takes (a 32-bit count of milliseconds): what "unbounded" comes to. */
export const SQLITE_MAX_WAIT_MS = 2 ** 31 - 1;
