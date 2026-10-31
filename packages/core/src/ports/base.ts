import type { Identity } from './identity.ts';
import type { TelemetryPort } from './telemetry.ts';

/** Members every port instance may expose, whatever the port. */
export interface PortBase {
  /** Instance name (for example the config key of a knowledge source). */
  readonly name?: string;
  /** Escape hatch: the underlying client or technology-specific API, for features the port does not cover. */
  native?(): unknown;
  /** Release connections, flush buffers. */
  close?(): Promise<void>;
}

/** Outbound credentials already bound to the caller of the current run. */
export interface BoundCredentials {
  token(audience: string, opts?: { scopes?: string[] }): Promise<string>;
}

/** Context passed to every port call. Identity flows everywhere; its token is never logged. */
export interface CallContext {
  runId: string;
  agent: string;
  identity?: Identity;
  sessionId?: string;
  signal?: AbortSignal;
  telemetry?: TelemetryPort;
  credentials?: BoundCredentials;
}
