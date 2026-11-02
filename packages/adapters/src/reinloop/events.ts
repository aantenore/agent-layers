import { ATTR, type RunEvent, type TelemetryPort } from '@agent-layers/core';
import type { RunEvent as LoopEvent } from 'reinloop';
import { finishOf, fromUsage } from './convert.ts';

/** Telemetry names of the adapter; the core's are `agent.*`. */
export const TELEMETRY = Object.freeze({
  compaction: 'reinloop.compaction',
  argsInvalid: 'reinloop.args_invalid',
  budgetExceeded: 'reinloop.budget.exceeded',
  costUsd: 'reinloop.cost.usd',
});

const BUDGET = 'budget:';

/** The budget a reinloop stop reason names (`budget:maxTurns` gives `maxTurns`). reinloop's own text, read at the edge only. */
export const budgetName = (reason: string | undefined): string | undefined => (reason?.startsWith(BUDGET) ? reason.slice(BUDGET.length) : undefined);

/**
 * reinloop events → run events of the SDK: the core events (`run.start`, `model.reply`, `tool.call`, `tool.result`,
 * `text`) plus the adapter's own `reinloop.usage` (tokens and cost of a turn), `reinloop.compaction` and
 * `reinloop.args_invalid`. Events carry no message text, tool arguments or tool output: they are appended to the
 * state slot. `text` is emitted for streamed deltas only (`stream: true`); `run.end` is built by the caller. Policy
 * decisions, message records and turn markers are dropped: the SDK pipeline owns authorization and already traces
 * each model and tool call.
 */
export function mapEvent(ev: LoopEvent, opts: { stream: boolean }): RunEvent[] {
  switch (ev.type) {
    case 'run_start':
      return [{ type: 'run.start', runId: ev.runId, agent: ev.data.agent }];
    case 'model_response': {
      if (ev.data.discarded) return [];
      const calls = ev.data.message.parts.filter((p) => p.type === 'tool_call').length;
      return [
        { type: 'model.reply', turn: ev.data.turn, model: ev.data.model, finish: calls ? 'tools' : finishOf(ev.data.stopReason), calls },
        { type: 'reinloop.usage', turn: ev.data.turn, usage: fromUsage(ev.data.usage), costUsd: ev.data.costUsd },
      ];
    }
    case 'tool_start':
      return [{ type: 'tool.call', id: ev.data.callId, tool: ev.data.name }];
    case 'tool_result':
      return [{ type: 'tool.result', id: ev.data.callId, tool: ev.data.name, ok: !ev.data.isError, durationMs: ev.data.durationMs }];
    case 'tool_args_invalid':
      return [{ type: 'reinloop.args_invalid', id: ev.data.callId, tool: ev.data.name, repaired: ev.data.repaired }];
    case 'compaction':
      return [{ type: 'reinloop.compaction', strategy: ev.data.strategy, beforeTokens: ev.data.beforeTokens, afterTokens: ev.data.afterTokens }];
    case 'text_delta':
      return opts.stream && ev.data.text ? [{ type: 'text', text: ev.data.text }] : [];
    default:
      return [];
  }
}

/**
 * Telemetry the pipeline cannot see: compaction, malformed tool arguments, budget stops and run cost. Model and tool
 * calls are not recorded here; the pipeline already spans each as `agent.model.call` or `agent.tool.call`.
 */
export function recordEvent(t: TelemetryPort, ev: LoopEvent, agent: string): void {
  if (ev.type === 'compaction') {
    t.event(TELEMETRY.compaction, {
      [ATTR.layer]: 'harness', [ATTR.name]: agent, 'reinloop.strategy': ev.data.strategy,
      'reinloop.tokens.before': ev.data.beforeTokens, 'reinloop.tokens.after': ev.data.afterTokens,
    });
  } else if (ev.type === 'tool_args_invalid') {
    t.event(TELEMETRY.argsInvalid, { [ATTR.layer]: 'harness', [ATTR.name]: agent, [ATTR.toolName]: ev.data.name, 'reinloop.repaired': ev.data.repaired });
  }
}

export function recordEnd(t: TelemetryPort, end: { agent: string; model: string; budget?: string; costUsd: number }): void {
  if (end.budget) t.event(TELEMETRY.budgetExceeded, { [ATTR.layer]: 'harness', [ATTR.name]: end.agent, 'reinloop.limit': end.budget });
  if (end.costUsd > 0) t.metric(TELEMETRY.costUsd, end.costUsd, { [ATTR.layer]: 'harness', [ATTR.name]: end.agent, [ATTR.modelRequested]: end.model });
}
