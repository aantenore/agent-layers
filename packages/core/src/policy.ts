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

/** Authorization request for calling a tool, built from the caller's identity and the tool spec. */
export function toolAccessRequest(tool: string, spec: ToolSpec, args: unknown, ctx: CallContext): AccessRequest {
  const id = ctx.identity;
  return {
    subject: { type: id?.kind ?? 'agent', id: id?.subject ?? ctx.agent, properties: { roles: id?.roles ?? [], scopes: id?.scopes ?? [] } },
    action: { name: 'call' },
    resource: { type: 'tool', id: tool, properties: { risk: riskOf(spec), agent: ctx.agent, layer: spec.layer ?? 'tool' } },
    context: { args },
  };
}

/** Reads the identity back from an access request (for policy engines that work on AccessRequest only). */
export function subjectOf(req: AccessRequest): PolicySubject {
  const props = req.subject.properties ?? {};
  return {
    tool: req.resource.id,
    risk: (req.resource.properties?.risk as ToolRisk | undefined) ?? 'exec',
    identity: {
      subject: req.subject.id,
      kind: req.subject.type === 'user' ? 'user' : 'agent',
      roles: Array.isArray(props.roles) ? props.roles : [],
      scopes: Array.isArray(props.scopes) ? props.scopes : [],
    },
  };
}
