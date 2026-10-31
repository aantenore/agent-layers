import type { Stack } from '../stack.ts';
import type { CallContext, PortBase } from './base.ts';
import type { ChatMessage, Usage } from './model.ts';

/** Agent definition, runtime-neutral. Schema: spec/schemas/agent-spec.json. */
export interface AgentSpec {
  name: string;
  instructions: string;
  model: string;
  /** Tool name globs, matched against prefixed names (`<source>__<tool>`). */
  tools: string[];
  /** Knowledge source names injected before model calls; all configured sources when omitted. */
  knowledge?: string[];
  /** Runtime- or model-specific parameters. */
  params?: Record<string, unknown>;
}

export type RunStatus = 'completed' | 'failed' | 'stopped' | (string & {});
export type RunInput = string | { messages: ChatMessage[] };

/** Runtime events are runtime-specific; `type` is the only shared field. */
export interface RunEvent { type: string; [k: string]: unknown }

export interface RunResult {
  runId: string;
  status: RunStatus;
  output: string;
  usage?: Usage;
  /** Why the run stopped or failed, e.g. `guardrail:<guard>:<stage>`. */
  reason?: string;
  events?: RunEvent[];
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

/** Something that should start a run (an event, a schedule tick). */
export interface Trigger {
  id: string;
  type: string;
  source: string;
  time?: string;
  /** Agent to run; when omitted the host picks one (the reference host uses the first configured agent). */
  agent?: string;
  data?: unknown;
}

export interface TriggerHandle { close(): Promise<void> }

/** Delivers triggers to a handler until closed. */
export interface TriggerPort extends PortBase {
  start(handler: (trigger: Trigger) => Promise<void>): Promise<TriggerHandle>;
}
