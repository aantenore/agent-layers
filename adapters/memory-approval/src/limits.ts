import { defineLimits } from '@agent-layers/core';

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  ttlMs: { path: 'options.ttlMs', default: 'unbounded', unit: 'ms', min: 1, unbounded: 'warn' },
});
