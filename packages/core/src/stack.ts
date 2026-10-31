import type { AdapterRegistry } from './adapter.ts';
import type { ResolvedConfig } from './config.ts';
import type { CallContext } from './ports/base.ts';
import type { CachePort, RouterPort } from './ports/cache.ts';
import type { ChannelHandle, ChannelHost, ChannelPort } from './ports/channel.ts';
import type { DeployPort, SecretPort } from './ports/deploy.ts';
import type { EvaluatorPort, FeedbackPort } from './ports/eval.ts';
import type { GuardPort } from './ports/guard.ts';
import type { ApprovalPort, AuthorizationPort, Caller, CredentialPort, IdentityPort } from './ports/identity.ts';
import type { IngestionPort, KnowledgePort, MemoryPort } from './ports/knowledge.ts';
import type { ModelPort } from './ports/model.ts';
import type { AgentSpec, RunnableAgent, RuntimePort, StatePort, TriggerPort } from './ports/runtime.ts';
import type { TelemetryPort } from './ports/telemetry.ts';
import type { ToolPort } from './ports/tool.ts';
import type { Vocabularies } from './vocab.ts';

/** The adapter instances of a stack, slot by slot, before composition. */
export interface StackPorts {
  deploy?: DeployPort;
  secrets?: SecretPort;
  model?: ModelPort;
  runtime?: RuntimePort;
  state?: StatePort;
  knowledge: Record<string, KnowledgePort>;
  memory?: MemoryPort;
  ingestion: Record<string, IngestionPort>;
  tools: Record<string, ToolPort>;
  identity?: IdentityPort;
  credentials?: CredentialPort;
  authorization?: AuthorizationPort;
  approval?: ApprovalPort;
  guardrails: GuardPort[];
  router?: RouterPort;
  cache?: CachePort;
  telemetry: TelemetryPort[];
  eval: EvaluatorPort[];
  feedback?: FeedbackPort;
  channels: ChannelPort[];
  triggers: TriggerPort[];
}

/** How channels and triggers started by the stack run. */
export interface StartOptions {
  /** Caller of runs whose call brings none: the caller of a terminal session, the service caller of triggers. */
  caller?: Caller;
}

/** A composed stack: the ports wired together, ready for a runtime. */
export interface Stack {
  readonly config: ResolvedConfig;
  readonly registry: AdapterRegistry;
  readonly ports: StackPorts;
  /** Effective vocabularies: core values plus what adapters declare and the config adds. */
  readonly vocabularies: Vocabularies;
  /** Problems found while composing that do not stop the stack (ext keys read but not produced). */
  readonly warnings: readonly string[];
  /** Fan-out over every telemetry adapter. */
  readonly telemetry: TelemetryPort;
  /** Model with knowledge injection, guards, cache and router applied. Throws when no model is configured. */
  readonly model: ModelPort;
  /** Every tool source, prefixed and governed (authorization, guards, credentials). */
  readonly tools: ToolPort;
  /** Model for one agent: injects only the agent's knowledge sources. */
  modelFor(agent: AgentSpec): ModelPort;
  /** Tools visible to one agent (its globs). */
  toolsFor(agent: AgentSpec): ToolPort;
  /** A fresh call context for a run. */
  context(init: Partial<CallContext> & { agent: string }): CallContext;
  /** Verifies an inbound credential through the identity slot. */
  verify(credential: string): Promise<Caller>;
  agents(): string[];
  /** The configured agent, bound by the runtime slot. */
  agent(name: string): Promise<RunnableAgent>;
  /** What channels need to reach the stack. Runs without a caller of their own get `opts.caller`. */
  host(opts?: StartOptions): ChannelHost;
  /**
   * Starts channels and triggers; their runs carry `opts.caller` unless a call brings its own.
   * The handle's `done` resolves when a self-ending channel (a terminal) ends.
   */
  start(opts?: StartOptions): Promise<ChannelHandle>;
  close(): Promise<void>;
}
