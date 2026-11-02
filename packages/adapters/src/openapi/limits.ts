import { defineLimits } from '@agent-layers/core';

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  timeoutMs: { path: 'options.timeoutMs', default: 30_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 120_000 } },
  maxResultChars: { path: 'options.maxResultChars', default: 16_000, unit: 'chars', min: 1, unbounded: 'fail', safe: { max: 100_000 } },
  errorBodyChars: { path: 'options.errorBodyChars', default: 500, unit: 'chars', min: 0, max: 100_000, safe: { max: 2000 } },
  minSecretChars: { path: 'options.minSecretChars', default: 4, unit: 'chars', min: 1, max: 64, safe: { max: 8 } },
  specTimeoutMs: { path: 'options.specTimeoutMs', default: 30_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 120_000 } },
  maxDescriptionChars: { path: 'options.maxDescriptionChars', default: 1000, unit: 'chars', min: 1, max: 100_000, safe: { max: 5000 } },
  maxRefDepth: { path: 'options.maxRefDepth', default: 24, unit: 'count', min: 1, max: 1000, safe: { max: 100 } },
});
