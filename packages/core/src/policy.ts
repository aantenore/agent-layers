import type { CallContext } from './ports/base.ts';
import { ANONYMOUS, publicCaller, type AccessQuestion, type Caller, type PublicCaller } from './ports/identity.ts';
import type { Risk, ToolSpec } from './ports/tool.ts';
import { matchesAny } from './util.ts';
import { CORE_VOCABULARIES, type Vocabularies } from './vocab.ts';

export type PolicyEffect = 'allow' | 'ask' | 'deny';

/** Local authorization rule. The first rule that matches decides. */
export interface PolicyRule {
  effect: PolicyEffect;
  /** Tool name globs (prefixed names); any tool when omitted. */
  tools?: string[];
  /** Risk values. A rule on a core value also matches the added values `like` it. */
  risk?: Risk[];
  /** Conditions on the caller. `authenticated: true` matches any verified caller, `false` only an anonymous one. */
  when?: { roles?: string[]; scopes?: string[]; kind?: 'user' | 'agent'; authenticated?: boolean };
}

/** What a policy rule is matched against. No `caller` means anonymous. */
export interface PolicySubject { tool: string; risk: Risk; caller?: Caller | PublicCaller }

/** Effect of the first matching rule, or undefined when no rule matches. */
export function evaluatePolicy(rules: readonly PolicyRule[], s: PolicySubject, vocab: Vocabularies = CORE_VOCABULARIES): PolicyEffect | undefined {
  return rules.find((r) => ruleMatches(r, s, vocab))?.effect;
}

function ruleMatches(r: PolicyRule, s: PolicySubject, vocab: Vocabularies): boolean {
  if (r.tools && !matchesAny(r.tools, s.tool)) return false;
  if (r.risk) {
    const core = vocab.core('risk', s.risk) ?? 'exec';
    if (!r.risk.includes(s.risk) && !r.risk.includes(core)) return false;
  }
  const w = r.when;
  if (!w) return true;
  const c = s.caller;
  if (w.authenticated !== undefined && w.authenticated !== (c !== undefined)) return false;
  if (w.kind && c?.kind !== w.kind) return false;
  if (w.roles && !w.roles.some((x) => c?.roles?.includes(x))) return false;
  if (w.scopes && !w.scopes.some((x) => c?.scopes?.includes(x))) return false;
  return true;
}

/** Tools without a declared risk are treated as the most dangerous kind. */
export const riskOf = (spec: Pick<ToolSpec, 'risk'>): Risk => spec.risk ?? 'exec';

/**
 * Access question for calling a tool, built from the caller and the tool spec. A call without a verified caller is
 * the explicit anonymous caller, never the agent's own identity. The spec's `attrs` become the target's.
 */
export function accessQuestion(tool: string, spec: ToolSpec, args: Record<string, unknown> | undefined, ctx: CallContext): AccessQuestion {
  return {
    caller: publicCaller(ctx.caller) ?? { ...ANONYMOUS, roles: [], scopes: [] },
    action: 'call',
    target: { kind: 'tool', id: tool, layer: spec.layer ?? 'tool', risk: riskOf(spec), agent: ctx.agent, ...(spec.attrs ? { attrs: spec.attrs } : {}) },
    ...(args ? { args } : {}),
  };
}

/**
 * The policy subject of an access question (for policy engines that work on questions only). Only callers of kind
 * `user` or `agent` with an id count as callers; anything else (anonymous, unknown kinds) has none, so rules on kind,
 * roles or scopes do not match, as in `evaluatePolicy`. An unknown risk counts as `exec`.
 */
export function policySubject(q: AccessQuestion, vocab: Vocabularies = CORE_VOCABULARIES): PolicySubject {
  const c = q.caller as Partial<PublicCaller> | undefined;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const risk = vocab.has('risk', q.target?.risk) ? q.target.risk : 'exec';
  const out: PolicySubject = { tool: String(q.target?.id ?? ''), risk };
  if ((c?.kind === 'user' || c?.kind === 'agent') && typeof c.id === 'string' && c.id) {
    out.caller = { id: c.id, kind: c.kind, roles: strings(c.roles), scopes: strings(c.scopes) };
  }
  return out;
}
