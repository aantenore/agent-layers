import { publicIdentity } from '../ports/identity.ts';
import type { CallContext } from '../ports/base.ts';
import type { GuardPort, GuardStage } from '../ports/guard.ts';
import type { TelemetryPort } from '../ports/telemetry.ts';

export interface GuardOutcome {
  action: 'allow' | 'block' | 'redact';
  text: string;
  /** Guard that blocked. */
  guard?: string;
  reason?: string;
}

export const guardName = (g: GuardPort, i: number) => g.name ?? `guard-${i}`;

export function guardsFor(guards: readonly GuardPort[], stage: GuardStage): GuardPort[] {
  return guards.filter((g) => !g.stages || g.stages.includes(stage));
}

/**
 * Runs the guards of one stage in order. Each guard sees the text as redacted by the previous one;
 * the first block stops the chain. A guard that throws counts as a block (fail closed).
 */
export async function runGuards(
  guards: readonly GuardPort[], stage: GuardStage, text: string, ctx: CallContext, telemetry: TelemetryPort, tool?: string,
): Promise<GuardOutcome> {
  let current = text;
  let redacted = false;
  for (const [i, g] of guardsFor(guards, stage).entries()) {
    const name = guardName(g, i);
    const verdict = await telemetry.span('guard.check', { 'agent.layer': 'guardrail', 'guard.name': name, 'guard.stage': stage, ...(tool ? { 'gen_ai.tool.name': tool } : {}) }, async (span) => {
      const subject = publicIdentity(ctx.identity);
      const v = await g.check({ stage, text: current, agent: ctx.agent, runId: ctx.runId, ...(tool ? { tool } : {}), ...(subject ? { subject } : {}) }, ctx.signal ? { signal: ctx.signal } : {})
        .catch((err: unknown) => ({ action: 'block' as const, reason: `guard failed: ${err instanceof Error ? err.message : String(err)}` }));
      span.setAttributes({ 'guard.action': v.action });
      return v;
    });
    if (verdict.action !== 'allow') {
      telemetry.metric('agent.guardrail.actions', 1, { 'agent.layer': 'guardrail', 'guard.name': name, 'guard.stage': stage, 'guard.action': verdict.action });
    }
    if (verdict.action === 'block') return { action: 'block', text: current, guard: name, ...(verdict.reason ? { reason: verdict.reason } : {}) };
    if (verdict.action === 'redact') {
      if (typeof verdict.text !== 'string') return { action: 'block', text: current, guard: name, reason: 'redact verdict without text' };
      current = verdict.text;
      redacted = true;
    }
  }
  return { action: redacted ? 'redact' : 'allow', text: current };
}
