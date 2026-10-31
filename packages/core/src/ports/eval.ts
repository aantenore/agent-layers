import type { Layer } from '../layers.ts';
import type { Ext, PortBase } from './base.ts';
import type { Usage } from './model.ts';
import type { RunEvent, RunInput, RunStatus, StopReason } from './runtime.ts';

/** One dataset line. Schema: spec/schemas/eval-case.json. */
export interface EvalCase { id: string; input: RunInput; expected?: unknown; tags?: string[]; layer?: Layer; ext?: Ext }
/** `value` in [0, 1]. */
export interface EvalScore { metric: string; value: number; layer?: Layer; reason?: string; ext?: Ext }
/** One result line. Schema: spec/schemas/eval-result.json. */
export interface EvalResult {
  id: string; runId: string; output: string; status: RunStatus; scores: EvalScore[];
  reason?: StopReason; usage?: Usage; costUsd?: number; ext?: Ext;
}
export interface EvalRun { runId: string; output?: string; status: RunStatus; reason?: StopReason; events?: RunEvent[] }

/** Scores one run of one case. */
export interface EvaluatorPort extends PortBase {
  score(c: EvalCase, run: EvalRun): Promise<EvalScore[]>;
}

/** Feedback on a run from a person or an app. Schema: spec/schemas/feedback.json. */
export interface Feedback {
  id?: string;
  runId: string;
  agent?: string;
  /** -1 (bad) to 1 (good). */
  rating?: number;
  label?: string;
  comment?: string;
  /** Who gave it (a caller id). */
  by?: string;
  at?: string;
  ext?: Ext;
}

/** Collects feedback so it can become evaluation data. */
export interface FeedbackPort extends PortBase {
  submit(feedback: Feedback): Promise<string>;
  list(q?: { runId?: string; agent?: string; since?: string; limit?: number }): Promise<Feedback[]>;
}
