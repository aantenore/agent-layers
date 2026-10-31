import { defineLimits } from '@agent-layers/core';

/** Limits both descriptors share: what is read from the provider and how much of it is kept. */
const shared = {
  maxTokenChars: { path: 'options.maxTokenChars', default: 16_384, unit: 'chars', min: 1, unbounded: 'fail', safe: { max: 65_536 } },
  maxResponseBytes: { path: 'options.maxResponseBytes', default: 1_000_000, unit: 'bytes', min: 1, unbounded: 'fail', safe: { max: 10_000_000 } },
  errorDescriptionChars: { path: 'options.errorDescriptionChars', default: 200, unit: 'chars', min: 0, max: 10_000, safe: { max: 1000 } },
} as const;

/** Configurable limits of the IdentityPort descriptor; see docs/limits.md. */
export const IDENTITY_LIMITS = defineLimits({
  clockSkewSec: { path: 'options.clockSkewSec', default: 60, unit: 's', min: 0, max: 600, safe: { max: 120 } },
  jwksMinRefreshMs: { path: 'options.jwksMinRefreshMs', default: 30_000, unit: 'ms', min: 1, safe: { min: 5000, max: 3_600_000 } },
  jwksMaxAgeMs: { path: 'options.jwksMaxAgeMs', default: 600_000, unit: 'ms', min: 1, safe: { min: 10_000, max: 86_400_000 } },
  timeoutMs: { path: 'options.timeoutMs', default: 5000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 120_000 } },
  maxKeyTries: { path: 'options.maxKeyTries', default: 5, unit: 'count', min: 1, safe: { max: 20 } },
  ...shared,
});

/** Configurable limits of the CredentialPort descriptor; see docs/limits.md. */
export const CREDENTIAL_LIMITS = defineLimits({
  refreshSkewSec: { path: 'options.refreshSkewSec', default: 30, unit: 's', min: 0, safe: { max: 300 } },
  defaultTtlSec: { path: 'options.defaultTtlSec', default: 60, unit: 's', min: 1, safe: { max: 3600 } },
  maxCacheEntries: { path: 'options.maxCacheEntries', default: 1000, unit: 'count', min: 1, unbounded: 'fail', safe: { max: 100_000 } },
  timeoutMs: { path: 'options.timeoutMs', default: 10_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 120_000 } },
  ...shared,
});
