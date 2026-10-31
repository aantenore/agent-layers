import type { Layer } from '../layers.ts';
import type { CachePort, RouterPort } from './cache.ts';
import type { ChannelPort } from './channel.ts';
import type { DeployPort, SecretPort } from './deploy.ts';
import type { EvaluatorPort, FeedbackPort } from './eval.ts';
import type { GuardPort } from './guard.ts';
import type { ApprovalPort, AuthorizationPort, CredentialPort, IdentityPort } from './identity.ts';
import type { IngestionPort, KnowledgePort, MemoryPort } from './knowledge.ts';
import type { ModelPort } from './model.ts';
import type { RuntimePort, StatePort, TriggerPort } from './runtime.ts';
import type { TelemetryPort } from './telemetry.ts';
import type { ToolPort } from './tool.ts';

/** Port name → instance type. */
export interface PortTypes {
  DeployPort: DeployPort;
  SecretPort: SecretPort;
  ModelPort: ModelPort;
  RuntimePort: RuntimePort;
  StatePort: StatePort;
  TriggerPort: TriggerPort;
  KnowledgePort: KnowledgePort;
  MemoryPort: MemoryPort;
  IngestionPort: IngestionPort;
  ToolPort: ToolPort;
  IdentityPort: IdentityPort;
  CredentialPort: CredentialPort;
  AuthorizationPort: AuthorizationPort;
  ApprovalPort: ApprovalPort;
  GuardPort: GuardPort;
  CachePort: CachePort;
  RouterPort: RouterPort;
  TelemetryPort: TelemetryPort;
  EvaluatorPort: EvaluatorPort;
  FeedbackPort: FeedbackPort;
  ChannelPort: ChannelPort;
}

export type PortName = keyof PortTypes;

export interface PortInfo {
  port: PortName;
  layer: Layer;
  /** Semver of the port contract. A breaking change bumps the major. */
  version: string;
  description: string;
}

export const PORTS: Readonly<Record<PortName, PortInfo>> = Object.freeze({
  DeployPort: { port: 'DeployPort', layer: 'infra', version: '0.1.0', description: 'Turn service specs into running endpoints' },
  SecretPort: { port: 'SecretPort', layer: 'infra', version: '0.1.0', description: 'Resolve secret references' },
  ModelPort: { port: 'ModelPort', layer: 'llm', version: '0.1.0', description: 'Chat completions with tool calls, optionally streamed' },
  RuntimePort: { port: 'RuntimePort', layer: 'harness', version: '0.1.0', description: 'Bind an agent spec to a runnable agent' },
  StatePort: { port: 'StatePort', layer: 'harness', version: '0.1.0', description: 'Session event log' },
  TriggerPort: { port: 'TriggerPort', layer: 'interface', version: '0.1.0', description: 'Start runs from events and schedules' },
  KnowledgePort: { port: 'KnowledgePort', layer: 'knowledge', version: '0.1.0', description: 'Search a knowledge source, answer with passages' },
  MemoryPort: { port: 'MemoryPort', layer: 'knowledge', version: '0.1.0', description: 'Long-term memory: remember, recall, forget' },
  IngestionPort: { port: 'IngestionPort', layer: 'knowledge', version: '0.1.0', description: 'Load, refresh and delete documents in a knowledge backend' },
  ToolPort: { port: 'ToolPort', layer: 'tool', version: '0.1.0', description: 'List and call tools' },
  IdentityPort: { port: 'IdentityPort', layer: 'identity', version: '0.1.0', description: 'Verify inbound credentials into an identity' },
  CredentialPort: { port: 'CredentialPort', layer: 'identity', version: '0.1.0', description: 'Outbound tokens, on behalf of a user or as the agent' },
  AuthorizationPort: { port: 'AuthorizationPort', layer: 'identity', version: '0.2.0', description: 'Decide whether an action is allowed' },
  ApprovalPort: { port: 'ApprovalPort', layer: 'identity', version: '0.1.0', description: 'Human approval for actions the policy marks ask' },
  GuardPort: { port: 'GuardPort', layer: 'guardrail', version: '0.1.0', description: 'Allow, block or redact text at four stages' },
  CachePort: { port: 'CachePort', layer: 'cache', version: '0.1.0', description: 'Key/value cache for model responses; usable by any layer' },
  RouterPort: { port: 'RouterPort', layer: 'cache', version: '0.1.0', description: 'Pick the model for a request' },
  TelemetryPort: { port: 'TelemetryPort', layer: 'telemetry', version: '0.1.0', description: 'Spans, events and metrics tagged with agent.layer' },
  EvaluatorPort: { port: 'EvaluatorPort', layer: 'eval', version: '0.1.0', description: 'Score a run of a dataset case' },
  FeedbackPort: { port: 'FeedbackPort', layer: 'eval', version: '0.1.0', description: 'User feedback attached to runs, as evaluation data' },
  ChannelPort: { port: 'ChannelPort', layer: 'interface', version: '0.1.0', description: 'Expose agents to people, apps and other agents' },
});

/** Semver per port. */
export const PORT_VERSIONS: Readonly<Record<PortName, string>> = Object.freeze(
  Object.fromEntries(Object.values(PORTS).map((p) => [p.port, p.version])) as Record<PortName, string>,
);

export function isPortName(value: unknown): value is PortName {
  return typeof value === 'string' && Object.hasOwn(PORTS, value);
}

export function portsOf(layer: Layer): PortInfo[] {
  return Object.values(PORTS).filter((p) => p.layer === layer);
}

/** True when an adapter built for `adapterVersion` can serve a port at `portVersion` (same major; 0.x: same minor). */
export function compatibleVersion(adapterVersion: string, portVersion: string): boolean {
  const [am = '', an = ''] = adapterVersion.split('.');
  const [pm = '', pn = ''] = portVersion.split('.');
  if (am !== pm) return false;
  return am !== '0' || an === pn;
}
