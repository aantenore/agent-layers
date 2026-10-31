import { ATTR, METRIC, SPAN } from '../names.ts';
import type { CallContext } from '../ports/base.ts';
import type { GuardLabel, GuardPort, GuardStage } from '../ports/guard.ts';
import { publicCaller } from '../ports/identity.ts';
import type { TelemetryPort } from '../ports/telemetry.ts';

export interface GuardOutcome {
  action: 'allow' | 'block' | 'redact';
  text: string;
  /** Guard that blocked. */
  guard?: string;
  /** Internal text of the guard that blocked; never parsed. */
  reason?: string;
  /** Labels of every guard that did not allow, in order. */
  labels?: GuardLabel[];
}

/** Reason of the block when a guard throws or rejects. Never the error's own message. */
export const GUARD_ERROR = 'guard error';

export const guardName = (g: GuardPort, i: number) => g.name ?? `guard-${i}`;

export function guardsFor(guards: readonly GuardPort[], stage: GuardStage): GuardPort[] {
  return guards.filter((g) => !g.stages || g.stages.includes(stage));
}

/**
 * Runs the guards of one stage in order. Each guard sees the text as redacted by the previous one;
 * the first block stops the chain. A guard that throws counts as a block (fail closed) with the reason `guard error`.
 */
export async function runGuards(
  guards: readonly GuardPort[], stage: GuardStage, text: string, ctx: CallContext, telemetry: TelemetryPort, tool?: string,
): Promise<GuardOutcome> {
  let current = text;
  let redacted = false;
  const labels: GuardLabel[] = [];
  const caller = publicCaller(ctx.caller);
  for (const [i, g] of guardsFor(guards, stage).entries()) {
    const name = guardName(g, i);
    const base = { [ATTR.layer]: 'guardrail' as const, [ATTR.guardName]: name, [ATTR.guardStage]: stage };
    const verdict = await telemetry.span(SPAN.guardCheck, { ...base, ...(tool ? { [ATTR.toolName]: tool } : {}) }, async (span) => {
      const v = await g.check({ stage, text: current, agent: ctx.agent, runId: ctx.runId, ...(tool ? { tool } : {}), ...(caller ? { caller } : {}) }, ctx.signal ? { signal: ctx.signal } : {})
        // The thrown text can echo the inspected content or a backend's credentials: the reason is fixed.
        .catch(() => ({ action: 'block' as const, reason: GUARD_ERROR, labels: ['other'] }));
      span.setAttributes({ [ATTR.guardAction]: v.action });
      return v;
    });
    if (verdict.action !== 'allow') {
      telemetry.metric(METRIC.guardActions, 1, { ...base, [ATTR.guardAction]: verdict.action });
      labels.push(...(verdict.labels ?? []));
    }
    const found = labels.length ? { labels: [...new Set(labels)] } : {};
    if (verdict.action === 'block') return { action: 'block', text: current, guard: name, ...(verdict.reason ? { reason: verdict.reason } : {}), ...found };
    if (verdict.action === 'redact') {
      if (typeof verdict.text !== 'string') return { action: 'block', text: current, guard: name, reason: 'redact verdict without text', ...found };
      current = verdict.text;
      redacted = true;
    }
  }
  return { action: redacted ? 'redact' : 'allow', text: current, ...(labels.length ? { labels: [...new Set(labels)] } : {}) };
}
