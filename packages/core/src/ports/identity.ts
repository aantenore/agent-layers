import type { PortBase } from './base.ts';

/** Who a run acts as: a person (on behalf of) or the agent's own identity. */
export interface Identity {
  subject: string;
  kind: 'user' | 'agent';
  roles?: string[];
  scopes?: string[];
  claims?: Record<string, unknown>;
  /** Raw inbound credential. Never written to events, logs or traces. */
  token?: string;
}

/** Inbound identity: turns a presented credential (bearer token, API key, ...) into an Identity. Rejects when invalid. */
export interface IdentityPort extends PortBase {
  verify(credential: string, opts?: { signal?: AbortSignal }): Promise<Identity>;
}

/** Outbound credentials: a token for a downstream audience, on behalf of `identity` or as the agent itself. */
export interface CredentialPort extends PortBase {
  token(audience: string, opts?: { identity?: Identity; scopes?: string[]; signal?: AbortSignal }): Promise<string>;
}

/** Authorization request: subject, action, resource, context. Schema: spec/schemas/access-request.json. */
export interface AccessRequest {
  subject: { type: string; id: string; properties?: { roles?: string[]; scopes?: string[]; [k: string]: unknown } };
  action: { name: string; properties?: Record<string, unknown> };
  resource: { type: string; id: string; properties?: { risk?: ToolRiskLevel; agent?: string; [k: string]: unknown } };
  context?: { args?: unknown; [k: string]: unknown };
}
type ToolRiskLevel = 'read' | 'write' | 'exec';

/** Schema: spec/schemas/access-decision.json. */
export interface AccessDecision {
  decision: boolean;
  context?: { reason?: string; [k: string]: unknown };
}

/** Authorization: decides whether an action is allowed. Implementations fail closed. */
export interface AuthorizationPort extends PortBase {
  evaluate(req: AccessRequest, opts?: { signal?: AbortSignal }): Promise<AccessDecision>;
}

/** Copy of an identity without its token, safe for guards, events and traces. */
export function publicIdentity(identity: Identity | undefined): Omit<Identity, 'token'> | undefined {
  if (!identity) return undefined;
  const { token: _token, ...rest } = identity;
  return rest;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRequest {
  access: AccessRequest;
  agent: string;
  runId: string;
  reason?: string;
  /** ISO time after which a pending approval becomes `expired`. */
  expiresAt?: string;
}

export interface Approval {
  id: string;
  status: ApprovalStatus;
  request: ApprovalRequest;
  decidedBy?: string;
  reason?: string;
}

/** Human in the loop: durable approvals for `ask` decisions, answered through any channel. */
export interface ApprovalPort extends PortBase {
  request(req: ApprovalRequest): Promise<Approval>;
  get(id: string): Promise<Approval | undefined>;
  decide(id: string, decision: { approved: boolean; by?: string; reason?: string }): Promise<Approval>;
  /** Resolves when the approval is no longer pending, or with the pending approval when `timeoutMs` elapses. */
  wait(id: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<Approval>;
}
