import type { Caller } from './identity.ts';
import type { TelemetryPort, TraceContext } from './telemetry.ts';

/** Members every port instance may expose, whatever the port. */
export interface PortBase {
  /** Instance name (for example the config key of a knowledge source). */
  readonly name?: string;
  /** Escape hatch: the underlying client or technology-specific API, for features the port does not cover. */
  native?(): unknown;
  /** Release connections, flush buffers. */
  close?(): Promise<void>;
  /**
   * Readiness: reaches the service the instance is configured for without changing anything there (an agent card, a
   * discovery document and key set) and rejects when it does not answer. The message names the host and the cause
   * class (`ECONNREFUSED`, an HTTP status), never a credential, a URL path or a response body. `agent-layers check`
   * runs it under `limits.check.timeoutMs` before the conformance probes; absent on adapters with no remote service.
   */
  probe?(opts?: { signal?: AbortSignal }): Promise<void>;
}

/**
 * Extension bag: data a shape carries beyond its fixed fields. Keys are `<namespace>.<name>` (the namespace is the
 * producing adapter's; `sdk.` is the core's), values are JSON. The core copies it and never reads adapter keys.
 */
export type Ext = Record<string, unknown>;

/** Plain attributes a filter or a policy may read (owner, tags, language). */
export type Attrs = Record<string, string | number | boolean | string[]>;

/** Outbound credentials already bound to the caller of the current run. */
export interface BoundCredentials {
  token(audience: string, opts?: { scopes?: string[] }): Promise<string>;
}

/** Context passed to every port call. The caller flows everywhere; its credential is never logged. */
export interface CallContext {
  runId: string;
  agent: string;
  /** Who the run acts for. Absent means anonymous. */
  caller?: Caller;
  sessionId?: string;
  signal?: AbortSignal;
  telemetry?: TelemetryPort;
  credentials?: BoundCredentials;
  /** Trace context of the request that started the run, from another process. Opaque to the core. */
  trace?: TraceContext;
  /**
   * Deadline, budget and hop count of the run (since 1.1.0 of the ports that take a context). Filled by the host when
   * a run starts and shared by every copy of the context: a read view of the run's ledger, debited by the core.
   * Absent in calls made outside a run.
   */
  bounds?: Bounds;
  /** Present when the run was started by another agent's run (since 1.1.0). */
  lineage?: Lineage;
  /**
   * What a calling agent sent: the bounds it passed on, as received by a channel (since 1.1.0). Read by the host when
   * the run starts (it can only tighten the stack's own limits) and removed from the run's context.
   */
  delegation?: Delegation;
}

/** Deadline, remaining budget and hop count of a run. Schema: spec/schemas/common.json#/$defs/Bounds. */
export interface Bounds {
  /** ISO 8601 time, local clock, by which the run must end. Absent only when `limits.run.timeoutMs` is unbounded and no caller sent a deadline. */
  deadlineAt?: string;
  /** Agent-to-agent calls before this run: 0 for a run a person or an event started. */
  hops: number;
  /** Largest `hops` the chain accepts. */
  maxHops: number;
  /** Tokens (input plus output) the run may still spend, delegated runs included. Absent: no token budget. */
  tokens?: number;
  /** Spend in US dollars the run may still incur, delegated runs included. Absent: no cost budget. */
  costUsd?: number;
  /** What calls in flight have reserved and not yet settled. */
  reserved?: { tokens?: number; costUsd?: number };
}

/** Where a run sits in a chain of agents, for correlation across stacks without a trace backend. */
export interface Lineage {
  /** Id of the run that started the chain. */
  rootRunId: string;
  /** Id of the run of the agent that called this one. */
  parentRunId: string;
}

/**
 * What one agent passes on to the next: what is left of its run's bounds. Time travels as remaining milliseconds,
 * never as a clock time, so clock skew between hosts cannot extend a deadline. Schema: common.json#/$defs/Delegation.
 */
export interface Delegation {
  remainingMs: number;
  /** Agent-to-agent calls in the chain including this one. */
  hops: number;
  maxHops: number;
  tokens?: number;
  costUsd?: number;
  rootRunId?: string;
  parentRunId?: string;
}
