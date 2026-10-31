import { defineLimits } from '@agent-layers/core';

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  maxQuoteChars: { path: 'options.maxQuoteChars', default: 60, unit: 'chars', min: 4, max: 10_000, safe: { max: 500 } },
});
