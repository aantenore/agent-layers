import { defineLimits } from '@agent-layers/core';

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  maxTokens: { path: 'options.maxTokens', default: null, fallback: 'the backend default', unit: 'tokens', min: 1, safe: { max: 4096 } },
  maxReasonChars: { path: 'options.maxReasonChars', default: 300, unit: 'chars', min: 1, max: 100_000, safe: { max: 2000 } },
});
