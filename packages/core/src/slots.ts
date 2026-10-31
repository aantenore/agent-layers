import type { Layer } from './layers.ts';
import { PORTS, type PortName } from './ports/catalog.ts';

export type SlotShape = 'single' | 'map' | 'list';
export interface SlotInfo { slot: string; port: PortName; layer: Layer; shape: SlotShape }

/** Config keys under `layers`, the port each one fills, and how many adapters it takes. */
const DEFS: [string, PortName, SlotShape][] = [
  ['deploy', 'DeployPort', 'single'],
  ['secrets', 'SecretPort', 'single'],
  ['model', 'ModelPort', 'single'],
  ['runtime', 'RuntimePort', 'single'],
  ['state', 'StatePort', 'single'],
  ['knowledge', 'KnowledgePort', 'map'],
  ['memory', 'MemoryPort', 'single'],
  ['ingestion', 'IngestionPort', 'map'],
  ['tools', 'ToolPort', 'map'],
  ['identity', 'IdentityPort', 'single'],
  ['credentials', 'CredentialPort', 'single'],
  ['authorization', 'AuthorizationPort', 'single'],
  ['approval', 'ApprovalPort', 'single'],
  ['guardrails', 'GuardPort', 'list'],
  ['router', 'RouterPort', 'single'],
  ['cache', 'CachePort', 'single'],
  ['telemetry', 'TelemetryPort', 'list'],
  ['eval', 'EvaluatorPort', 'list'],
  ['feedback', 'FeedbackPort', 'single'],
  ['channels', 'ChannelPort', 'list'],
  ['triggers', 'TriggerPort', 'list'],
];

export const SLOTS: readonly SlotInfo[] = Object.freeze(DEFS.map(([slot, port, shape]) => ({ slot, port, layer: PORTS[port].layer, shape })));
export type SlotName = (typeof DEFS)[number][0];

export function slotInfo(slot: string): SlotInfo | undefined {
  return SLOTS.find((s) => s.slot === slot);
}
