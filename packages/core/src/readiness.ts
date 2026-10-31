import type { AdapterRegistry } from './adapter.ts';
import { configuredAdapters, PRODUCTION_REQUIRES, type ResolvedConfig } from './config.ts';
import { errorMessage } from './errors.ts';
import { slotInfo, type SlotName } from './slots.ts';

export interface ReadinessProblem {
  kind: 'not-installed' | 'prototype-only' | 'missing-layer' | 'load-failed';
  slot: SlotName;
  adapter?: string;
  message: string;
}

export interface Readiness { ok: boolean; tier: ResolvedConfig['tier']; requires: SlotName[]; problems: ReadinessProblem[] }

/**
 * Readiness gate for a resolved profile: every adapter is installed; on the production tier, no adapter is
 * prototype-only and every required slot is configured (default: identity, authorization, guardrails, telemetry, state).
 */
export async function readiness(config: ResolvedConfig, registry: AdapterRegistry): Promise<Readiness> {
  const problems: ReadinessProblem[] = [];
  for (const a of configuredAdapters(config.layers)) {
    let found;
    try {
      found = await registry.resolve(a.port, a.ref.adapter);
    } catch (err) {
      problems.push({ kind: 'load-failed', slot: a.slot, adapter: a.ref.adapter, message: `${a.slot}: adapter "${a.ref.adapter}" failed to load: ${errorMessage(err)}` });
      continue;
    }
    if (!found) {
      problems.push({ kind: 'not-installed', slot: a.slot, adapter: a.ref.adapter, message: `${a.slot}: adapter "${a.ref.adapter}" is not installed (npm install @agent-layers/adapter-${a.ref.adapter}, or add a plugin)` });
    } else if (config.tier === 'production' && !found.tiers.includes('production')) {
      problems.push({ kind: 'prototype-only', slot: a.slot, adapter: a.ref.adapter, message: `${a.slot}: adapter "${a.ref.adapter}" is prototype-only and cannot be used on the production tier` });
    }
  }
  const requires = config.requires ?? (config.tier === 'production' ? [...PRODUCTION_REQUIRES] : []);
  for (const slot of requires) {
    const v = (config.layers as Record<string, unknown>)[slot];
    const empty = v == null || (Array.isArray(v) && v.length === 0) || (slotInfo(slot)?.shape === 'map' && Object.keys(v as object).length === 0);
    if (empty) problems.push({ kind: 'missing-layer', slot, message: `${slot}: required by profile ${config.profile ?? '(base)'} but not configured` });
  }
  return { ok: problems.length === 0, tier: config.tier, requires, problems };
}
