import {
  addUsage, callsOf, defineLimits, limitValue, replyText, stopReasonOf, textMessage, toolInfos,
  type AgentSpec, type CallContext, type Message, type RunEvent, type RunInput, type RunResult, type StopReason, type Stack, type ToolResult, type Usage,
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

/** Runs one agent: model call → tool calls → model call … until a final answer, the turn limit or a call waiting for a person. */
export async function* runLoop(stack: Stack, agent: AgentSpec, input: RunInput, ctx: CallContext, opts: LoopOptions): AsyncGenerator<RunEvent, RunResult> {
  const maxTurns = limitValue(LIMITS.maxTurns, opts.maxTurns);
  const model = stack.modelFor(agent);
  const tools = stack.toolsFor(agent);
  const messages: Message[] = [
    ...(agent.instructions ? [textMessage('system', agent.instructions)] : []),
    ...(typeof input === 'string' ? [textMessage('user', input)] : input.messages),
  ];
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  // Undefined once a call has no price: a partial sum would look like a real total.
  let costUsd: number | undefined = opts.pricing ? 0 : undefined;
  const end = (status: RunResult['status'], output: string, reason?: StopReason): RunResult =>
    ({ runId: ctx.runId, status, output, usage, ...(costUsd !== undefined ? { costUsd } : {}), ...(reason ? { reason } : {}) });

  yield { type: 'run.start', runId: ctx.runId, agent: agent.name };
  try {
    const specs = agent.tools.length ? await tools.listTools(ctx) : [];
    for (let turn = 1; turn <= maxTurns; turn++) {
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
      for (const call of calls) {
        yield { type: 'tool.call', id: call.id, tool: call.tool };
        const started = Date.now();
        const out: ToolResult = call.invalid !== undefined
          ? { ok: false, text: 'Arguments must be a JSON object' }
          : await tools.callTool(call.tool, call.args, ctx);
        yield { type: 'tool.result', id: call.id, tool: call.tool, ok: out.ok, durationMs: Date.now() - started };
        messages.push({ role: 'tool', parts: [{ type: 'result', callId: call.id, ok: out.ok, text: out.text, ...(out.data !== undefined ? { data: out.data } : {}) }] });
        const approval = out.ext?.['sdk.approval'];
        if (typeof approval === 'string') {
          const by = stack.ports.approval?.name;
          return end('waiting', '', { code: 'needs_input', layer: 'identity', ...(by ? { by } : {}), detail: approval });
        }
      }
    }
    return end('stopped', '', { code: 'limit', layer: 'harness', detail: 'turns' });
  } catch (err) {
    if (ctx.signal?.aborted) return end('stopped', '', abortReason(ctx.signal));
    const reason = stopReasonOf(err);
    return end(reason.code === 'error' ? 'failed' : 'stopped', '', reason);
  }
}
