import { defineLimits } from '@agent-layers/core';

/** Configurable limits of the opa descriptor; see docs/limits.md. */
export const LIMITS = defineLimits({
  timeoutMs: { path: 'options.timeoutMs', default: 5000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 30_000 } },
  maxResponseBytes: { path: 'options.maxResponseBytes', default: 1_000_000, unit: 'bytes', min: 1, unbounded: 'fail', safe: { max: 10_000_000 } },
  maxReasonChars: { path: 'options.maxReasonChars', default: 200, unit: 'chars', min: 1, max: 100_000, safe: { max: 2000 } },
});
