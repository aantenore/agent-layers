import type { Layer } from '../layers.ts';
import type { Stack } from '../stack.ts';
import type { CallContext, Ext, PortBase } from './base.ts';
import type { InboundMount } from './channel.ts';
import type { GuardStage } from './guard.ts';
import type { Caller } from './identity.ts';
import type { Finish, Message, ModelSettings, Usage } from './model.ts';

/** Agent definition, runtime-neutral. Schema: spec/schemas/agent-spec.json. */
export interface AgentSpec {
  name: string;
  instructions: string;
  model: string;
  /** Tool name globs, matched against prefixed names (`<source>__<tool>`). */
  tools: string[];
  /** Knowledge source names injected before model calls; all configured sources when omitted. */
  knowledge?: string[];
  settings?: ModelSettings;
  /** Runtime- or adapter-specific settings, namespaced. */
  ext?: Ext;
}

/** `waiting`: the run stopped for a human answer (an approval, input, authentication) and can be resumed. */
export type RunStatus = 'completed' | 'failed' | 'stopped' | 'waiting';

/** Why a run did not complete. Core values; config may add values `like` one of them. */
export type StopCode =
  | 'guard_block' | 'denied' | 'aborted' | 'timeout' | 'limit' | 'needs_input' | 'needs_auth' | 'rejected' | 'error'
  | (string & {});

/** Structured stop reason. Required on a RunResult whose status is not `completed`. */
export interface StopReason {
  code: StopCode;
  /** Layer that stopped the run. */
  layer?: Layer;
  /** Instance that stopped it (a guard name, an approval adapter, a remote agent). */
  by?: string;
  stage?: GuardStage;
  /** Internal text, never parsed. */
  detail?: string;
}

export type RunInput = string | { messages: Message[] };

/** Core run events, with fixed payloads. `at` is an ISO time. */
export type CoreRunEvent =
  | { type: 'run.start'; runId: string; agent: string; at?: string }
  | { type: 'model.reply'; turn: number; model: string; finish: Finish; calls: number; at?: string }
  | { type: 'tool.call'; id: string; tool: string; at?: string }
  | { type: 'tool.result'; id: string; tool: string; ok: boolean; durationMs?: number; at?: string }
  | { type: 'text'; text: string; at?: string }
  | { type: 'run.end'; status: RunStatus; reason?: StopReason; usage?: Usage; costUsd?: number; at?: string };

/** Adapter event, `<namespace>.<name>`: stored and replayed, never read by the core. */
export interface ExtRunEvent { type: `${string}.${string}`; at?: string; [k: string]: unknown }

/** Schema: spec/schemas/run-event.json. */
export type RunEvent = CoreRunEvent | ExtRunEvent;
export type EventType = CoreRunEvent['type'];

/** Schema: spec/schemas/run-result.json. */
export interface RunResult {
  runId: string;
  status: RunStatus;
  output: string;
  /** Required when `status` is not `completed`. */
  reason?: StopReason;
  usage?: Usage;
  /** Cost of the run in US dollars, when known (model prices, or reported by a remote agent). */
  costUsd?: number;
  events?: RunEvent[];
  ext?: Ext;
}

export interface RunnableAgent {
  readonly name: string;
  run(input: RunInput, ctx?: Partial<CallContext>): Promise<RunResult>;
  stream?(input: RunInput, ctx?: Partial<CallContext>): AsyncIterable<RunEvent>;
}

/** Binds an agent spec to a runnable agent that uses the stack's ports. */
export interface RuntimePort extends PortBase {
  bind(stack: Stack, agent: AgentSpec): RunnableAgent | Promise<RunnableAgent>;
}

/** Session state as an append-only event log per session. */
export interface StatePort extends PortBase {
  append(sessionId: string, events: RunEvent[]): Promise<void>;
  read(sessionId: string): Promise<RunEvent[]>;
  list(opts?: { limit?: number }): Promise<string[]>;
  delete(sessionId: string): Promise<void>;
}

/** Something that should start a run (an event, a schedule tick). Schema: spec/schemas/trigger.json. */
export interface Trigger {
  /** The SDK's id; the upstream event id goes in `ext`. */
  id: string;
  kind: string;
  source: string;
  at?: string;
  /** Agent to run; when omitted the host picks one (the reference host uses the first configured agent). */
  agent?: string;
  data?: unknown;
  ext?: Ext;
}

export interface TriggerHandle { close(): Promise<void> }

/** Where a mounted trigger hands its triggers: the host accepts them and runs them in the background. */
export interface TriggerSink {
  agents(): string[];
  /**
   * Accepts a trigger and starts its run without waiting for it; resolves to the run id. Rejects when the trigger
   * cannot be accepted: unknown agent, or no caller where the host requires one.
   */
  accept(trigger: Trigger, ctx?: { caller?: Caller }): Promise<{ runId: string }>;
  /** Verifies a credential (for example the trigger's configured service credential); absent without an identity layer. */
  verify?(credential: string): Promise<Caller>;
}

/** Delivers triggers to a handler until closed (`start`), or receives them on a host server (`mount`). */
export interface TriggerPort extends PortBase {
  start?(handler: (trigger: Trigger) => Promise<void>): Promise<TriggerHandle>;
  mount?(sink: TriggerSink): InboundMount | Promise<InboundMount>;
}
