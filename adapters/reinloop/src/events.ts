import type { RunEvent, TelemetryPort } from '@agent-layers/core';
import type { RunEvent as LoopEvent } from 'reinloop';
import { finishReasonOf, toChatUsage } from './convert.ts';

/**
 * reinloop events → run events of the SDK, in the vocabulary other runtimes use (`run_start`, `model_response`,
 * `tool_call`, `tool_result`, `text`, `run_end`) plus `compaction` and `tool_args_invalid`. Events carry no message
 * text, tool arguments or tool output: they are appended to the state slot. `text` is emitted for streamed deltas
 * only (`stream: true`); `run_end` is built by the caller. Policy decisions, message records and turn markers are
 * dropped: the SDK pipeline owns authorization and already traces each model and tool call.
 */
export function mapEvent(ev: LoopEvent, opts: { stream: boolean }): RunEvent | undefined {
  switch (ev.type) {
    case 'run_start':
      return { type: 'run_start', runId: ev.runId, agent: ev.data.agent };
    case 'model_response':
      if (ev.data.discarded) return undefined;
      return {
        type: 'model_response', turn: ev.data.turn, model: ev.data.model, finish_reason: finishReasonOf(ev.data.stopReason),
        toolCalls: ev.data.message.parts.filter((p) => p.type === 'tool_call').length, usage: toChatUsage(ev.data.usage), costUsd: ev.data.costUsd,
      };
    case 'tool_start':
      return { type: 'tool_call', id: ev.data.callId, name: ev.data.name };
    case 'tool_result':
      return { type: 'tool_result', id: ev.data.callId, name: ev.data.name, isError: ev.data.isError, durationMs: ev.data.durationMs };
    case 'tool_args_invalid':
      return { type: 'tool_args_invalid', id: ev.data.callId, name: ev.data.name, repaired: ev.data.repaired };
    case 'compaction':
      return { type: 'compaction', strategy: ev.data.strategy, beforeTokens: ev.data.beforeTokens, afterTokens: ev.data.afterTokens };
    case 'text_delta':
      return opts.stream && ev.data.text ? { type: 'text', text: ev.data.text } : undefined;
    default:
      return undefined;
  }
}

/**
 * Telemetry the pipeline cannot see: compaction, malformed tool arguments, budget stops and run cost. Model and tool
 * calls are not recorded here; the pipeline already wraps each in a `chat` or `execute_tool` span.
 */
export function recordEvent(t: TelemetryPort, ev: LoopEvent, agent: string): void {
  if (ev.type === 'compaction') {
    t.event('agent.compaction', {
      'agent.layer': 'harness', 'gen_ai.agent.name': agent, 'compaction.strategy': ev.data.strategy,
      'compaction.tokens.before': ev.data.beforeTokens, 'compaction.tokens.after': ev.data.afterTokens,
    });
  } else if (ev.type === 'tool_args_invalid') {
    t.event('agent.tool.args_invalid', { 'agent.layer': 'harness', 'gen_ai.agent.name': agent, 'gen_ai.tool.name': ev.data.name, 'tool.args.repaired': ev.data.repaired });
  }
}

export function recordEnd(t: TelemetryPort, end: { agent: string; model: string; reason?: string; costUsd: number }): void {
  if (end.reason?.startsWith('budget:')) {
    t.event('agent.budget.exceeded', { 'agent.layer': 'harness', 'gen_ai.agent.name': end.agent, 'budget.limit': end.reason.slice('budget:'.length) });
  }
  if (end.costUsd > 0) t.metric('agent.cost.usd', end.costUsd, { 'agent.layer': 'harness', 'gen_ai.agent.name': end.agent, 'gen_ai.request.model': end.model });
}
