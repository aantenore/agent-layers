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
}
