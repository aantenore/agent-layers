import { defineLimits } from '@agent-layers/core';

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  busyTimeoutMs: { path: 'options.busyTimeoutMs', default: 5000, unit: 'ms', min: 0, unbounded: 'fail', safe: { max: 60_000 } },
  maxKeyChars: { path: 'options.maxKeyChars', default: 512, unit: 'chars', min: 16, max: 4096 },
  maxValueBytes: { path: 'options.maxValueBytes', default: 65_536, unit: 'bytes', min: 1024, max: 16_777_216, safe: { max: 1_048_576 } },
  listLimit: { path: 'options.listLimit', default: 100, unit: 'count', min: 1, max: 10_000 },
  retainMs: { path: 'options.retainMs', default: 3_600_000, unit: 'ms', min: 0, unbounded: 'warn' },
});

/** How often writes prune expired rows past `retainMs` (besides once on open). */
export const PRUNE_EVERY_MS = 60_000;

/** Largest wait SQLite takes (a 32-bit count of milliseconds): what "unbounded" comes to. */
export const SQLITE_MAX_WAIT_MS = 2 ** 31 - 1;
