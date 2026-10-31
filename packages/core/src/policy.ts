import type { CallContext } from './ports/base.ts';
import type { AccessRequest, Identity } from './ports/identity.ts';
import type { ToolRisk, ToolSpec } from './ports/tool.ts';
import { matchesAny } from './util.ts';

export type PolicyEffect = 'allow' | 'ask' | 'deny';

/** Local authorization rule. The first rule that matches decides. */
export interface PolicyRule {
  effect: PolicyEffect;
  /** Tool name globs (prefixed names); any tool when omitted. */
  tools?: string[];
  risk?: ToolRisk[];
  when?: { roles?: string[]; scopes?: string[]; kind?: 'user' | 'agent' };
}

export interface PolicySubject { tool: string; risk: ToolRisk; identity?: Identity }

/** Effect of the first matching rule, or undefined when no rule matches. */
export function evaluatePolicy(rules: readonly PolicyRule[], s: PolicySubject): PolicyEffect | undefined {
  return rules.find((r) => ruleMatches(r, s))?.effect;
}

function ruleMatches(r: PolicyRule, s: PolicySubject): boolean {
  if (r.tools && !matchesAny(r.tools, s.tool)) return false;
  if (r.risk && !r.risk.includes(s.risk)) return false;
  const w = r.when;
  if (!w) return true;
  const id = s.identity;
  if (w.kind && id?.kind !== w.kind) return false;
  if (w.roles && !w.roles.some((x) => id?.roles?.includes(x))) return false;
  if (w.scopes && !w.scopes.some((x) => id?.scopes?.includes(x))) return false;
  return true;
}

/** Tools without a declared risk are treated as the most dangerous kind. */
export const riskOf = (spec: Pick<ToolSpec, 'risk'>): ToolRisk => spec.risk ?? 'exec';

/** Subject of a call made without a verified identity. Never matches user or agent rules. */
const ANONYMOUS_SUBJECT = 'anonymous';

/**
 * Authorization request for calling a tool, built from the caller's identity and the tool spec. A call without a
 * verified identity is an explicit anonymous subject (`authenticated: false`), never the agent's own identity.
 */
export function toolAccessRequest(tool: string, spec: ToolSpec, args: unknown, ctx: CallContext): AccessRequest {
  const id = ctx.identity;
  return {
    subject: id
      ? { type: id.kind, id: id.subject, properties: { roles: id.roles ?? [], scopes: id.scopes ?? [], authenticated: true } }
      : { type: ANONYMOUS_SUBJECT, id: ANONYMOUS_SUBJECT, properties: { roles: [], scopes: [], authenticated: false } },
    action: { name: 'call' },
    resource: { type: 'tool', id: tool, properties: { risk: riskOf(spec), agent: ctx.agent, layer: spec.layer ?? 'tool' } },
    context: { args },
  };
}

/**
 * Reads the identity back from an access request (for policy engines that work on AccessRequest only). Only the exact
 * subject types `user` and `agent` of an authenticated subject yield an identity; anything else (anonymous, unknown
 * types, `authenticated: false`) has none, so rules on kind, roles or scopes do not match, as in `evaluatePolicy`.
 */
export function subjectOf(req: AccessRequest): PolicySubject {
  const subject = req.subject ?? ({} as Partial<AccessRequest['subject']>);
  const props = subject.properties ?? {};
  const kind = subject.type === 'user' || subject.type === 'agent' ? subject.type : undefined;
  const authenticated = props.authenticated !== false;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const risk = req.resource.properties?.risk;
  const out: PolicySubject = { tool: req.resource.id, risk: risk === 'read' || risk === 'write' ? risk : 'exec' };
  if (kind && authenticated && typeof subject.id === 'string' && subject.id) {
    out.identity = { subject: subject.id, kind, roles: strings(props.roles), scopes: strings(props.scopes) };
  }
  return out;
}
