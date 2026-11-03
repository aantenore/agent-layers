import type { Layer } from './layers.ts';
import type { Ext } from './ports/base.ts';
import type { GuardStage } from './ports/guard.ts';
import type { RunStatus, StopReason } from './ports/runtime.ts';

/**
 * Brands an error class so `instanceof` also matches instances built by another copy of this module (an app that ends
 * up with two installs of the package). The brand is a registry symbol on the prototype: a subclass instance carries
 * its base's brand, a sibling class does not.
 */
function brand<T extends abstract new (...args: never[]) => Error>(cls: T, name: string): T {
  const key = Symbol.for(`agent-layers.error.${name}`);
  Object.defineProperty(cls.prototype, key, { value: true });
  Object.defineProperty(cls, Symbol.hasInstance, {
    configurable: true,
    value(this: Function, x: unknown): boolean {
      return (typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[key] === true) || Function.prototype[Symbol.hasInstance].call(this, x);
    },
  });
  return cls;
}

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

/**
 * A governed tool call waits for a human approval. The stack's tools throw it inside a run; the stack ends the run
 * `waiting` with `stopReason` (code `needs_input`) and `ext["sdk.approval"]` (`approvalExt`). A runtime may let it
 * propagate, or end the run itself with `runEndOf(err)`.
 */
export class ApprovalPending extends AgentLayersError {
  override name = 'ApprovalPending';
  /** Approval id, for `ApprovalPort.get` / `decide`. */
  readonly approval: string;
  /** Approval instance that holds it. */
  readonly by: string | undefined;
  /** Prefixed name of the tool waiting for it. */
  readonly tool: string | undefined;
  /** Arguments of the call waiting for it, kept by the host to resume the run; never written to the result. */
  readonly args: Record<string, unknown> | undefined;
  constructor(approval: string, opts: { by?: string; tool?: string; args?: Record<string, unknown> } = {}) {
    super(`approval pending: ${approval}`);
    this.approval = approval;
    this.by = opts.by;
    this.tool = opts.tool;
    this.args = opts.args;
  }

  get stopReason(): StopReason {
    return { code: 'needs_input', layer: 'identity', ...(this.by ? { by: this.by } : {}), detail: this.approval };
  }

  /** What the stack writes on the RunResult: `ext["sdk.approval"] = {id, by?, tool?}`. */
  get approvalExt(): Ext {
    return { 'sdk.approval': { id: this.approval, ...(this.by ? { by: this.by } : {}), ...(this.tool ? { tool: this.tool } : {}) } };
  }
}

/**
 * A run reached one of its bounds: its deadline (`timeout`), its token or cost budget (`limit`), or the hop limit of
 * its chain (`hop_limit`). Thrown by the core's model pipeline before a model call it refuses, and by `outboundBounds`
 * before a call to another agent; runtimes end the run `stopped` with `stopReason`.
 */
export class BoundsExceeded extends AgentLayersError {
  override name = 'BoundsExceeded';
  readonly stopReason: StopReason;
  constructor(reason: StopReason) {
    super(`run bounds reached: ${reason.code}`);
    this.stopReason = reason;
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

export type RunRefusal = 'not_found' | 'forbidden' | 'conflict' | 'invalid';

/**
 * A resume or a cancel the stack refused: no such run (or not kept any more), a caller who may not act on it, a run
 * in a state that does not allow it (cancelled, already being resumed, an approval still pending), or an answer that
 * does not fit what the run waits for. Channels map `kind` to their protocol's error.
 */
export class RunRefused extends AgentLayersError {
  override name = 'RunRefused';
  readonly kind: RunRefusal;
  constructor(kind: RunRefusal, message: string) {
    super(message);
    this.kind = kind;
  }
}

// Every class is branded after its definition (a class's own brand also matches its subclasses).
brand(AgentLayersError, 'AgentLayersError');
brand(AdapterError, 'AdapterError');
brand(ConfigError, 'ConfigError');
brand(GuardrailBlocked, 'GuardrailBlocked');
brand(ApprovalPending, 'ApprovalPending');
brand(BoundsExceeded, 'BoundsExceeded');
brand(MappingError, 'MappingError');
brand(MissingLayerError, 'MissingLayerError');
brand(InboundRejected, 'InboundRejected');
brand(RunRefused, 'RunRefused');

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
  if (err instanceof GuardrailBlocked || err instanceof ApprovalPending || err instanceof BoundsExceeded) return err.stopReason;
  if (err instanceof Error && err.name === 'TimeoutError') return { code: 'timeout' };
  if (isAbort(err)) return { code: 'aborted' };
  if (err instanceof MissingLayerError) return { code: 'error', layer: err.layer, detail: err.name };
  return { code: 'error', ...(err instanceof Error ? { detail: err.name } : {}) };
}

/** How an error ends a run: `waiting` for a pending approval, `failed` for an error, `stopped` otherwise. */
export function runEndOf(err: unknown): { status: RunStatus; reason: StopReason } {
  const reason = stopReasonOf(err);
  return { status: err instanceof ApprovalPending ? 'waiting' : reason.code === 'error' ? 'failed' : 'stopped', reason };
}
