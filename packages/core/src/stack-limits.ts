import { defineLimits, limitList, type LimitSpec } from './limits.ts';

/** Limits of the gateway (`gateway` block of the stack config). */
export const GATEWAY_LIMITS = defineLimits({
  maxBodyBytes: { path: 'gateway.maxBodyBytes', default: 1_048_576, unit: 'bytes', min: 1, unbounded: 'fail', safe: { max: 16_777_216 } },
  requestTimeoutMs: { path: 'gateway.requestTimeoutMs', default: 300_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 900_000 } },
  headersTimeoutMs: { path: 'gateway.headersTimeoutMs', default: 30_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 60_000 } },
  bodyTimeoutMs: { path: 'gateway.bodyTimeoutMs', default: 120_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 300_000 } },
  closeGraceMs: { path: 'gateway.closeGraceMs', default: 10_000, unit: 'ms', min: 0, max: 3_600_000 },
  corsMaxAgeS: { path: 'gateway.corsMaxAgeS', default: 600, unit: 's', min: 0, max: 86_400 },
  maxRequestIdChars: { path: 'gateway.maxRequestIdChars', default: 64, unit: 'chars', min: 1, max: 256 },
});

/** Limits of the composition pipelines (`pipeline` block). */
export const PIPELINE_LIMITS = defineLimits({
  k: { path: 'pipeline.knowledge.k', default: 4, unit: 'count', min: 1, safe: { max: 20 } },
  maxChars: { path: 'pipeline.knowledge.maxChars', default: 4000, unit: 'chars', min: 200, safe: { max: 32_000 } },
  maxK: { path: 'pipeline.knowledge.maxK', default: 20, unit: 'count', min: 1, max: 1000 },
  cacheTtlMs: { path: 'pipeline.cacheTtlMs', default: null, fallback: 'the cache adapter\'s TTL', unit: 'ms', min: 0 },
  approvalTimeoutMs: { path: 'pipeline.approvalTimeoutMs', default: 0, unit: 'ms', min: 0, safe: { max: 3_600_000 } },
});

/** Limits of `agent-layers check` (`limits.check` block). */
export const CHECK_LIMITS = defineLimits({
  timeoutMs: { path: 'limits.check.timeoutMs', default: 30_000, unit: 'ms', min: 1 },
  deployTimeoutMs: { path: 'limits.check.deployTimeoutMs', default: 300_000, unit: 'ms', min: 1 },
  listToolsTimeoutMs: { path: 'limits.check.listToolsTimeoutMs', default: 5000, unit: 'ms', min: 1 },
});

/** Every limit set in the stack config itself (adapters declare theirs on the descriptor). */
export const STACK_LIMITS: readonly LimitSpec[] = [...limitList(GATEWAY_LIMITS), ...limitList(PIPELINE_LIMITS), ...limitList(CHECK_LIMITS)];
