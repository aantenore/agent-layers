import type { PortBase } from './base.ts';
import type { Identity } from './identity.ts';

export type GuardStage = 'input' | 'output' | 'tool_args' | 'tool_result';
export const GUARD_STAGES: readonly GuardStage[] = ['input', 'output', 'tool_args', 'tool_result'];

/** Schema: spec/schemas/guard-request.json. */
export interface GuardInput {
  stage: GuardStage;
  text: string;
  agent: string;
  runId: string;
  tool?: string;
  subject?: Omit<Identity, 'token'>;
}

/** Schema: spec/schemas/guard-verdict.json. `text` is required for `redact`. */
export interface GuardVerdict {
  action: 'allow' | 'block' | 'redact';
  text?: string;
  reason?: string;
}

/** Inspect text at one of four stages. */
export interface GuardPort extends PortBase {
  /** Stages this guard runs at; all when omitted. */
  stages?: readonly GuardStage[];
  check(input: GuardInput, opts?: { signal?: AbortSignal }): Promise<GuardVerdict>;
}
