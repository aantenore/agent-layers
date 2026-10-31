import type { Layer } from './layers.ts';
import type { GuardStage } from './ports/guard.ts';
import type { StopReason } from './ports/runtime.ts';

/** Base class of every error raised by the core. */
export class AgentLayersError extends Error {
  override name = 'AgentLayersError';
}

/** Problem resolving, configuring or creating an adapter. The message names the layer and the adapter. */
export class AdapterError extends AgentLayersError {
  override name = 'AdapterError';
  readonly layer: Layer;
  readonly adapter: string;
  constructor(layer: Layer, adapter: string, message: string, options?: ErrorOptions) {
    super(`[${layer}/${adapter}] ${message}`, options);
    this.layer = layer;
    this.adapter = adapter;
  }
}

/** Invalid stack configuration. `errors` lists every problem found, with its JSON path. */
export class ConfigError extends AgentLayersError {
  override name = 'ConfigError';
  readonly errors: string[];
  readonly file: string | undefined;
  constructor(errors: string[], file?: string) {
    super(`${file ? `${file}: ` : ''}invalid configuration\n  ${errors.join('\n  ')}`);
    this.errors = errors;
    this.file = file;
  }
}

/**
 * A guard blocked input or output. Runtimes end the run with status `stopped` and `stopReason` (code `guard_block`).
 * `reason` is the guard's internal text: never shown to the caller, never parsed.
 */
export class GuardrailBlocked extends AgentLayersError {
  override name = 'GuardrailBlocked';
  readonly guard: string;
  readonly stage: GuardStage;
  readonly reason: string | undefined;
  constructor(guard: string, stage: GuardStage, reason?: string) {
    super(`blocked by guard ${guard} at ${stage}`);
    this.guard = guard;
    this.stage = stage;
    this.reason = reason;
  }

  get stopReason(): StopReason {
    return { code: 'guard_block', layer: 'guardrail', by: this.guard, stage: this.stage };
  }
}

/** A mapping rule failed or produced an invalid shape. In the identity and authorization slots it rejects or denies. */
export class MappingError extends AgentLayersError {
  override name = 'MappingError';
  readonly key: string;
  constructor(key: string, message: string, options?: ErrorOptions) {
    super(`mappings.${key}: ${message}`, options);
    this.key = key;
  }
}

/** A port was used that the stack does not configure. */
export class MissingLayerError extends AgentLayersError {
  override name = 'MissingLayerError';
  readonly layer: Layer;
  constructor(layer: Layer, what: string) {
    super(`no ${what} configured (layer ${layer})`);
    this.layer = layer;
  }
}

export type InboundRejection = 'unauthenticated' | 'forbidden' | 'not_found' | 'invalid';

/** A host refused an inbound call or trigger. Inbound adapters map `kind` to their protocol's error. */
export class InboundRejected extends AgentLayersError {
  override name = 'InboundRejected';
  readonly kind: InboundRejection;
  constructor(kind: InboundRejection, message: string) {
    super(message);
    this.kind = kind;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * The stop reason for an error that ended a run: a guard block, an abort, a timeout, otherwise `error`. `detail` is
 * the error name only, never its message (which can echo inspected content or a backend's credentials).
 */
export function stopReasonOf(err: unknown): StopReason {
  if (err instanceof GuardrailBlocked) return err.stopReason;
  if (err instanceof Error && err.name === 'TimeoutError') return { code: 'timeout' };
  if (isAbort(err)) return { code: 'aborted' };
  if (err instanceof MissingLayerError) return { code: 'error', layer: err.layer, detail: err.name };
  return { code: 'error', ...(err instanceof Error ? { detail: err.name } : {}) };
}
