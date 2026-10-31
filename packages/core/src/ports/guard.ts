import type { Ext, PortBase } from './base.ts';
import type { PublicCaller } from './identity.ts';

export type GuardStage = 'input' | 'output' | 'tool_args' | 'tool_result';
export const GUARD_STAGES: readonly GuardStage[] = ['input', 'output', 'tool_args', 'tool_result'];

/** What a guard found. Core values; config may add values `like` one of them. Native names go in `ext`. */
export type GuardLabel = 'pii' | 'secret' | 'injection' | 'toxicity' | 'policy' | 'other' | (string & {});

/** Schema: spec/schemas/guard-check.json. */
export interface GuardCheck {
  stage: GuardStage;
  text: string;
  agent: string;
  runId: string;
  tool?: string;
  caller?: PublicCaller;
  ext?: Ext;
}

/** Schema: spec/schemas/guard-verdict.json. `text` is required for `redact`. */
export interface GuardVerdict {
  action: 'allow' | 'block' | 'redact';
  text?: string;
  labels?: GuardLabel[];
  /** Human text, internal only; never parsed. */
  reason?: string;
  ext?: Ext;
}

/** Inspect text at one of four stages. */
export interface GuardPort extends PortBase {
  /** Stages this guard runs at; all when omitted. */
  stages?: readonly GuardStage[];
  check(input: GuardCheck, opts?: { signal?: AbortSignal }): Promise<GuardVerdict>;
}
