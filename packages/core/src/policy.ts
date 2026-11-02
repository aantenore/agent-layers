import type { CallContext } from './ports/base.ts';
import { ANONYMOUS, publicCaller, type AccessQuestion, type Actor, type Caller, type PublicCaller } from './ports/identity.ts';
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
  /**
   * Actions (since AuthorizationPort 1.2.0): `call`, `decide`, `list` or values added `like` one of them; a rule on a
   * core value also matches the values added like it. A rule without `actions` matches tool calls only (`call`), so
   * rules written for tools never open other actions.
   */
  actions?: string[];
  /**
   * Conditions on the caller. `authenticated: true` matches any verified caller, `false` only an anonymous one.
   * Delegation (`Caller.actors`): `actor` matches the id of the current actor (the agent presenting the credential) by
   * glob, and only when there is one; `actors` matches any actor of the chain, prior ones included (RFC 8693 counts
   * only the current actor for access control, so a rule asks for prior ones explicitly); `delegated: true` matches a
   * caller with at least one actor, `false` one with none.
   */
  when?: { roles?: string[]; scopes?: string[]; kind?: 'user' | 'agent'; authenticated?: boolean; actor?: string[]; actors?: string[]; delegated?: boolean };
}

/** What a policy rule is matched against. No `caller` means anonymous; no `action` means `call`. */
export interface PolicySubject { tool: string; risk: Risk; caller?: Caller | PublicCaller; action?: string }

/** Effect of the first matching rule, or undefined when no rule matches. */
export function evaluatePolicy(rules: readonly PolicyRule[], s: PolicySubject, vocab: Vocabularies = CORE_VOCABULARIES): PolicyEffect | undefined {
  return rules.find((r) => ruleMatches(r, s, vocab))?.effect;
}

function ruleMatches(r: PolicyRule, s: PolicySubject, vocab: Vocabularies): boolean {
  const action = s.action ?? 'call';
  const coreAction = vocab.core('action', action);
  if (r.actions ? !(r.actions.includes(action) || (coreAction !== undefined && r.actions.includes(coreAction))) : coreAction !== 'call') return false;
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
  const chain = c?.actors ?? [];
  if (w.delegated !== undefined && w.delegated !== (chain.length > 0)) return false;
  if (w.actor && !(chain.length && matchesAny(w.actor, chain[chain.length - 1]!.id))) return false;
  if (w.actors && !chain.some((a) => matchesAny(w.actors!, a.id))) return false;
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
 * `user` or `agent` with an id count as callers (with their well-formed actors); anything else (anonymous, unknown kinds) has none, so rules on kind,
 * roles or scopes do not match, as in `evaluatePolicy`. An unknown risk counts as `exec`.
 */
export function policySubject(q: AccessQuestion, vocab: Vocabularies = CORE_VOCABULARIES): PolicySubject {
  const c = q.caller as Partial<PublicCaller> | undefined;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const risk = vocab.has('risk', q.target?.risk) ? q.target.risk : 'exec';
  const out: PolicySubject = { tool: String(q.target?.id ?? ''), risk, ...(typeof q.action === 'string' ? { action: q.action } : {}) };
  if ((c?.kind === 'user' || c?.kind === 'agent') && typeof c.id === 'string' && c.id) {
    const actors = (Array.isArray(c.actors) ? c.actors : [])
      .filter((a): a is Actor => !!a && typeof a.id === 'string' && !!a.id && (a.kind === 'user' || a.kind === 'agent'))
      .map((a) => ({ id: a.id, kind: a.kind }));
    out.caller = { id: c.id, kind: c.kind, roles: strings(c.roles), scopes: strings(c.scopes), ...(actors.length ? { actors } : {}) };
  }
  return out;
}
