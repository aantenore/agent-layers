import type { Layer } from '../layers.ts';
import type { PortBase } from './base.ts';
import type { Usage } from './model.ts';
import type { RunEvent, RunStatus } from './runtime.ts';

/** One dataset line. Schema: spec/schemas/eval-case.json. */
export interface EvalCase { id: string; input: string; expected?: unknown; tags?: string[]; layer?: Layer }
export interface EvalScore { metric: string; value: number; layer?: Layer; reason?: string }
/** One result line. Schema: spec/schemas/eval-result.json. */
export interface EvalResult { id: string; runId: string; output: string; status: string; scores: EvalScore[]; usage?: Usage; costUsd?: number }
export interface EvalRun { runId: string; output?: string; status: RunStatus; events?: RunEvent[] }

/** Scores one run of one case. */
export interface EvaluatorPort extends PortBase {
  score(c: EvalCase, run: EvalRun): Promise<EvalScore[]>;
}

/** Feedback on a run from a person or an app. */
export interface Feedback {
  id?: string;
  runId: string;
  agent?: string;
  /** -1 (bad) to 1 (good). */
  rating?: number;
  label?: string;
  comment?: string;
  subject?: string;
  time?: string;
}

/** Collects feedback so it can become evaluation data. */
export interface FeedbackPort extends PortBase {
  submit(feedback: Feedback): Promise<string>;
  list(q?: { runId?: string; agent?: string; since?: string; limit?: number }): Promise<Feedback[]>;
}
