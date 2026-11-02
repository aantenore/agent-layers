import { defineLimits } from '@agent-layers/core';

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  timeoutMs: { path: 'options.timeoutMs', default: 30_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 120_000 } },
  maxResponseBytes: { path: 'options.maxResponseBytes', default: 1_048_576, unit: 'bytes', min: 1, unbounded: 'fail', safe: { max: 16_777_216 } },
});
