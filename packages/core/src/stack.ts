import type { AdapterRegistry } from './adapter.ts';
import type { ResolvedConfig } from './config.ts';
import type { CallContext } from './ports/base.ts';
import type { CachePort, RouterPort } from './ports/cache.ts';
import type { CancelOptions, CancelResult, ChannelHandle, ChannelHost, ChannelPort } from './ports/channel.ts';
import type { DeployPort, SecretPort } from './ports/deploy.ts';
import type { EvaluatorPort, FeedbackPort } from './ports/eval.ts';
import type { GuardPort } from './ports/guard.ts';
import type { AccessTarget, ApprovalPort, AuthorizationPort, Caller, CredentialPort, IdentityPort } from './ports/identity.ts';
import type { IngestionPort, KnowledgePort, MemoryPort } from './ports/knowledge.ts';
import type { ModelPort } from './ports/model.ts';
import type { AgentSpec, ResumeAnswer, RunnableAgent, RunResult, RuntimePort, StatePort, TriggerPort } from './ports/runtime.ts';
import type { StorePort } from './ports/store.ts';
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
  store?: StorePort;
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
  /**
   * Every tool source, prefixed and governed (authorization, guards, credentials). A call waiting for an approval throws
   * `ApprovalPending`, which ends the run `waiting`; for a runtime built for RuntimePort 1.0 it is the pending result
   * (`ext["sdk.approval"]`) instead.
   */
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
  /**
   * Continues a run that ended `waiting`, as `ctx.caller` (the verified resumer). Only the caller that started the run
   * may resume it, unless the authorization port allows the resumer `decide` on the approval the run waits for (on the
   * run itself, target kind `run`, when it waits for input). An approval answer is decided first (`ApprovalPort.decide`, authorized like
   * the gateway's `decide`); then the runtime continues from its checkpoint when it implements `resume`, or the agent
   * runs again from its input (not deterministic with a real model). The run keeps its id, session and caller.
   * Rejects with `RunRefused`.
   */
  resume(runId: string, answer: ResumeAnswer, ctx?: Partial<CallContext>): Promise<RunResult>;
  /**
   * Cancels a run: aborts it when it is in flight in this process, or marks a waiting run cancelled and withdraws its
   * pending approval (`ApprovalPort.cancel`). Only the caller that started the run, unless the authorization port
   * allows `decide` on its approval (or on the run). Rejects with `RunRefused`.
   */
  cancel(runId: string, opts?: CancelOptions): Promise<CancelResult>;
  /**
   * The access target of a run in flight in this process or kept waiting (`{ kind: "run", agent, attrs.tool? }`), so a
   * host can authorize an action on that run before asking for it; undefined when there is no such run.
   */
  runTarget(runId: string): Promise<AccessTarget | undefined>;
  /** What channels need to reach the stack. Runs without a caller of their own get `opts.caller`. */
  host(opts?: StartOptions): ChannelHost;
  /**
   * Starts channels and triggers; their runs carry `opts.caller` unless a call brings its own.
   * The handle's `done` resolves when a self-ending channel (a terminal) ends.
   */
  start(opts?: StartOptions): Promise<ChannelHandle>;
  close(): Promise<void>;
}
