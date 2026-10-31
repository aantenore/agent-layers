import type { Layer } from '../layers.ts';
import type { Attrs, Ext, PortBase } from './base.ts';
import type { Risk } from './tool.ts';

/** Who a run acts for: a person (on behalf of) or an agent. Schema: spec/schemas/caller.json. */
export interface Caller {
  id: string;
  kind: 'user' | 'agent';
  /** Empty list, never absent. */
  roles: string[];
  /** Empty list, never absent. */
  scopes: string[];
  /** Display name. */
  name?: string;
  /** The inbound credential. Never serialised, logged or traced. */
  credential?: string;
  ext?: Ext;
}

/** A caller without its credential: what guards, events and access questions see. */
export type PublicCaller = Omit<Caller, 'credential'>;

/** The caller of a request without a verified identity. Explicit, never the agent. */
export interface AnonymousCaller { kind: 'anonymous'; id: 'anonymous'; roles: []; scopes: [] }

/** Inbound identity: turns a presented credential (bearer token, API key, ...) into a Caller. Rejects when invalid. */
export interface IdentityPort extends PortBase {
  verify(credential: string, opts?: { signal?: AbortSignal }): Promise<Caller>;
}

/** Outbound credentials: a token for a downstream audience, on behalf of `caller` or as the agent itself. */
export interface CredentialPort extends PortBase {
  /** True when tokens are issued only on behalf of a caller: `token` rejects without `caller.credential`. */
  readonly requiresCaller?: boolean;
  token(audience: string, opts?: { caller?: Caller; scopes?: string[]; signal?: AbortSignal }): Promise<string>;
}

/** Actions an access question asks about. Core value `call`; config may add values `like` it. */
export type Action = 'call' | (string & {});

/** What is being accessed. */
export interface AccessTarget {
  /** `tool` today. */
  kind: string;
  id: string;
  layer: Layer;
  risk: Risk;
  agent: string;
  attrs?: Attrs;
}

/** Schema: spec/schemas/access-question.json. */
export interface AccessQuestion {
  caller: PublicCaller | AnonymousCaller;
  action: Action;
  target: AccessTarget;
  /** The call's arguments; an adapter sends them on only when configured to. */
  args?: Record<string, unknown>;
  ext?: Ext;
}

/** Schema: spec/schemas/access-decision.json. Errors are a deny. */
export interface AccessDecision {
  allowed: boolean;
  /** Kept inside the stack, never shown to the caller. */
  reason?: string;
  ext?: Ext;
}

/** Authorization: decides whether an action is allowed. Implementations fail closed. */
export interface AuthorizationPort extends PortBase {
  evaluate(q: AccessQuestion, opts?: { signal?: AbortSignal }): Promise<AccessDecision>;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRequest {
  question: AccessQuestion;
  agent: string;
  runId: string;
  reason?: string;
  /** ISO time after which a pending approval becomes `expired`. */
  expiresAt?: string;
  /**
   * Identifies the call being approved: a stable hash of the session, the caller and the access question (arguments
   * included). Set by the tool pipeline so a later identical call finds the decision with `lookup`.
   */
  key?: string;
  ext?: Ext;
}

/** Schema: spec/schemas/approval.json. */
export interface Approval {
  id: string;
  status: ApprovalStatus;
  request: ApprovalRequest;
  decidedBy?: string;
  reason?: string;
  ext?: Ext;
}

/** Human in the loop: durable approvals for `ask` decisions, answered through any channel. */
export interface ApprovalPort extends PortBase {
  request(req: ApprovalRequest): Promise<Approval>;
  get(id: string): Promise<Approval | undefined>;
  decide(id: string, decision: { approved: boolean; by?: string; reason?: string }): Promise<Approval>;
  /** Resolves when the approval is no longer pending, or with the pending approval when `timeoutMs` elapses. */
  wait(id: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<Approval>;
  /**
   * The latest approval requested with `key` that has not been consumed, or undefined. With `consume`, an approved
   * approval is marked consumed in the same step, so it lets exactly one call proceed. Since 1.1.0; without it, every
   * call asks again.
   */
  lookup?(key: string, opts?: { consume?: boolean }): Promise<Approval | undefined>;
}

/** Copy of a caller without its credential, safe for guards, events and traces. */
export function publicCaller(caller: Caller | undefined): PublicCaller | undefined {
  if (!caller) return undefined;
  const { credential: _credential, ...rest } = caller;
  return rest;
}

/** The caller of a request without a verified identity. */
export const ANONYMOUS: Readonly<AnonymousCaller> = Object.freeze({ kind: 'anonymous', id: 'anonymous', roles: [] as [], scopes: [] as [] });
