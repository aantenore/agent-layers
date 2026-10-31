import type { Layer } from './layers.ts';
import type { GuardStage } from './ports/guard.ts';

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

/** A guard blocked input or output. Runtimes end the run with status `stopped` and `reason` = message. */
export class GuardrailBlocked extends AgentLayersError {
  override name = 'GuardrailBlocked';
  readonly guard: string;
  readonly stage: GuardStage;
  readonly reason: string | undefined;
  constructor(guard: string, stage: GuardStage, reason?: string) {
    super(`guardrail:${guard}:${stage}`);
    this.guard = guard;
    this.stage = stage;
    this.reason = reason;
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
