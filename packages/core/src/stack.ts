import type { AdapterRegistry } from './adapter.ts';
import type { ResolvedConfig } from './config.ts';
import type { CallContext } from './ports/base.ts';
import type { CachePort, RouterPort } from './ports/cache.ts';
import type { ChannelHandle, ChannelHost, ChannelPort } from './ports/channel.ts';
import type { DeployPort, SecretPort } from './ports/deploy.ts';
import type { EvaluatorPort, FeedbackPort } from './ports/eval.ts';
import type { GuardPort } from './ports/guard.ts';
import type { ApprovalPort, AuthorizationPort, CredentialPort, Identity, IdentityPort } from './ports/identity.ts';
import type { IngestionPort, KnowledgePort, MemoryPort } from './ports/knowledge.ts';
import type { ModelPort } from './ports/model.ts';
import type { AgentSpec, RunnableAgent, RuntimePort, StatePort, TriggerPort } from './ports/runtime.ts';
import type { TelemetryPort } from './ports/telemetry.ts';
import type { ToolPort } from './ports/tool.ts';

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
  /** Identity of runs whose call brings none: the caller of a terminal session, the service identity of triggers. */
  identity?: Identity;
}

/** A composed stack: the ports wired together, ready for a runtime. */
export interface Stack {
  readonly config: ResolvedConfig;
  readonly registry: AdapterRegistry;
  readonly ports: StackPorts;
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
  verify(credential: string): Promise<Identity>;
  agents(): string[];
  /** The configured agent, bound by the runtime slot. */
  agent(name: string): Promise<RunnableAgent>;
  /** What channels need to reach the stack. Runs without an identity of their own get `opts.identity`. */
  host(opts?: StartOptions): ChannelHost;
  /**
   * Starts channels and triggers; their runs carry `opts.identity` unless a call brings its own.
   * The handle's `done` resolves when a self-ending channel (a terminal) ends.
   */
  start(opts?: StartOptions): Promise<ChannelHandle>;
  close(): Promise<void>;
}
