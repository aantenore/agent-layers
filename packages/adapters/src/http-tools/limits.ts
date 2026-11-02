import { defineLimits } from '@agent-layers/core';

/** Configurable limits; see docs/limits.md. The `tool*` ones override the top-level option for one tool. */
export const LIMITS = defineLimits({
  timeoutMs: { path: 'options.timeoutMs', default: 30_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 120_000 } },
  maxResultChars: { path: 'options.maxResultChars', default: 16_000, unit: 'chars', min: 1, unbounded: 'fail', safe: { max: 100_000 } },
  errorBodyChars: { path: 'options.errorBodyChars', default: 500, unit: 'chars', min: 0, max: 100_000, safe: { max: 2000 } },
  minSecretChars: { path: 'options.minSecretChars', default: 4, unit: 'chars', min: 1, max: 64, safe: { max: 8 } },
  toolTimeoutMs: { path: 'options.tools.*.timeoutMs', default: null, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 120_000 }, fallback: 'options.timeoutMs' },
  toolMaxResultChars: { path: 'options.tools.*.maxResultChars', default: null, unit: 'chars', min: 1, unbounded: 'fail', safe: { max: 100_000 }, fallback: 'options.maxResultChars' },
});
