import { defineLimits } from '@agent-layers/core';

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  timeoutMs: { path: 'options.timeoutMs', default: 30_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 120_000 } },
});
