import {
  addUsage, ApprovalPending, callsOf, defineLimits, limitValue, replyText, runEndOf, stopReasonOf, textMessage, toolInfos,
  type AgentSpec, type CallContext, type CallPart, type JsonValue, type Message, type RunEvent, type RunInput, type RunResult, type StopReason, type Stack,
  type ToolResult, type Usage,
} from '@agent-layers/core';

/** Price of a model in US dollars per million tokens. */
export interface ModelPrice { inputPerMTok?: number; outputPerMTok?: number }

export interface LoopOptions {
  /** Model calls per run (default 8). */
  maxTurns?: number;
  /** Prices by model id, matched on the model the reply names, else the agent's model. Runs report `costUsd` when every call is priced. */
  pricing?: Record<string, ModelPrice>;
}

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  maxTurns: { path: 'options.maxTurns', default: 8, unit: 'count', min: 1, max: 100, safe: { max: 25 } },
});

/** Why the run stopped when the caller aborted or a timeout fired; a signal with a plain reason is an abort. */
function abortReason(signal: AbortSignal): StopReason {
  const reason = stopReasonOf(signal.reason);
  return reason.code === 'error' ? { code: 'aborted' } : reason;
}

/**
 * Where a waiting run stopped: the conversation so far, the calls of the last answer still to run (the one waiting for
 * a person first) and the turns used. Plain JSON: the host keeps it and hands it back to `resume`.
 */
export interface LoopCheckpoint {
  messages: Message[];
  calls: CallPart[];
  turn: number;
}

/** A checkpoint, or undefined when `value` is not one this loop wrote. */
export function asCheckpoint(value: unknown): LoopCheckpoint | undefined {
  const v = value as Partial<LoopCheckpoint> | null;
  return v && typeof v === 'object' && Array.isArray(v.messages) && Array.isArray(v.calls) && typeof v.turn === 'number' ? v as LoopCheckpoint : undefined;
}

const userMessages = (input: RunInput): Message[] => (typeof input === 'string' ? [textMessage('user', input)] : input.messages);

/**
 * Runs one agent: model call → tool calls → model call … until a final answer, the turn limit or a call waiting for a
 * person. With `from`, continues a waiting run: runs the calls left in its checkpoint (the waiting one first, which now
 * finds its decision), adds `from.input` to the conversation when given, and goes on with the next turn.
 */
export async function* runLoop(
  stack: Stack, agent: AgentSpec, input: RunInput, ctx: CallContext, opts: LoopOptions, from?: { checkpoint: LoopCheckpoint; input?: RunInput },
): AsyncGenerator<RunEvent, RunResult> {
  const maxTurns = limitValue(LIMITS.maxTurns, opts.maxTurns);
  const model = stack.modelFor(agent);
  const tools = stack.toolsFor(agent);
  const messages: Message[] = from ? [...from.checkpoint.messages] : [
    ...(agent.instructions ? [textMessage('system', agent.instructions)] : []),
    ...userMessages(input),
  ];
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  // Undefined once a call has no price: a partial sum would look like a real total.
  let costUsd: number | undefined = opts.pricing ? 0 : undefined;
  const end = (status: RunResult['status'], output: string, reason?: StopReason, checkpoint?: LoopCheckpoint): RunResult => ({
    runId: ctx.runId, status, output, usage, ...(costUsd !== undefined ? { costUsd } : {}), ...(reason ? { reason } : {}),
    ...(checkpoint ? { checkpoint: JSON.parse(JSON.stringify(checkpoint)) as JsonValue } : {}),
  });

  /**
   * Runs the calls of one answer in order. A call waiting for a person stops the batch: its result is not added, and
   * the waiting call with those after it are what a resume runs.
   */
  async function* execute(calls: CallPart[]): AsyncGenerator<RunEvent, { pending: ApprovalPending; rest: CallPart[] } | undefined> {
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      yield { type: 'tool.call', id: call.id, tool: call.tool };
      const started = Date.now();
      let out: ToolResult;
      let pending: ApprovalPending | undefined;
      try {
        out = call.invalid !== undefined ? { ok: false, text: 'Arguments must be a JSON object' } : await tools.callTool(call.tool, call.args, ctx);
      } catch (err) {
        // The stack's tools throw ApprovalPending for a call waiting for a person.
        if (!(err instanceof ApprovalPending)) throw err;
        pending = err;
        out = { ok: false, text: `Waiting for approval ${err.approval}` };
      }
      yield { type: 'tool.result', id: call.id, tool: call.tool, ok: out.ok, durationMs: Date.now() - started };
      // Tools that return a pending result instead (`ext["sdk.approval"]`) end the run the same way.
      const approval = out.ext?.['sdk.approval'];
      if (!pending && typeof approval === 'string') {
        const by = stack.ports.approval?.name;
        pending = new ApprovalPending(approval, { tool: call.tool, args: call.args, ...(by ? { by } : {}) });
      }
      if (pending) return { pending, rest: calls.slice(i) };
      messages.push({ role: 'tool', parts: [{ type: 'result', callId: call.id, ok: out.ok, text: out.text, ...(out.data !== undefined ? { data: out.data } : {}) }] });
    }
    return undefined;
  }

  const first = from ? from.checkpoint.turn + 1 : 1;
  yield { type: 'run.start', runId: ctx.runId, agent: agent.name };
  try {
    const specs = agent.tools.length ? await tools.listTools(ctx) : [];
    if (from) {
      const stop = yield* execute(from.checkpoint.calls);
      if (stop) return end('waiting', '', stop.pending.stopReason, { messages, calls: stop.rest, turn: from.checkpoint.turn });
      if (from.input !== undefined) messages.push(...userMessages(from.input));
    }
    for (let turn = first; turn <= maxTurns; turn++) {
      if (ctx.signal?.aborted) return end('stopped', '', abortReason(ctx.signal));
      const reply = await model.chat({
        model: agent.model, messages, ...(specs.length ? { tools: toolInfos(specs) } : {}),
        ...(agent.settings ? { settings: agent.settings } : {}), ...(agent.ext ? { ext: agent.ext } : {}),
      }, ctx);
      usage = addUsage(usage, reply.usage)!;
      if (costUsd !== undefined) {
        const price = opts.pricing?.[reply.model] ?? opts.pricing?.[agent.model];
        costUsd = price ? costUsd + ((reply.usage?.inputTokens ?? 0) * (price.inputPerMTok ?? 0) + (reply.usage?.outputTokens ?? 0) * (price.outputPerMTok ?? 0)) / 1e6 : undefined;
      }
      const calls = callsOf(reply.message);
      yield { type: 'model.reply', turn, model: reply.model, finish: reply.finish, calls: calls.length };
      messages.push(reply.message);
      if (reply.finish !== 'tools' || !calls.length) {
        const output = replyText(reply);
        if (output) yield { type: 'text', text: output };
        return end('completed', output);
      }
      const stop = yield* execute(calls);
      if (stop) return end('waiting', '', stop.pending.stopReason, { messages, calls: stop.rest, turn });
    }
    return end('stopped', '', { code: 'limit', layer: 'harness', detail: 'turns' });
  } catch (err) {
    if (ctx.signal?.aborted) return end('stopped', '', abortReason(ctx.signal));
    const { status, reason } = runEndOf(err);
    return end(status, '', reason);
  }
}
