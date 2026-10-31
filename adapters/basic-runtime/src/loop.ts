import {
  GuardrailBlocked, toChatTools, type AgentSpec, type CallContext, type ChatMessage, type RunEvent, type RunInput, type RunResult,
  type Stack, type Usage,
} from '@agent-layers/core';

export interface LoopOptions {
  /** Model calls per run (default 8). */
  maxTurns?: number;
}

const PARAM_KEYS = ['temperature', 'max_tokens', 'stop'] as const;

/** Runs one agent: model call → tool calls → model call … until a final answer or the turn limit. */
export async function* runLoop(stack: Stack, agent: AgentSpec, input: RunInput, ctx: CallContext, opts: LoopOptions): AsyncGenerator<RunEvent, RunResult> {
  const model = stack.modelFor(agent);
  const tools = stack.toolsFor(agent);
  const messages: ChatMessage[] = [
    ...(agent.instructions ? [{ role: 'system' as const, content: agent.instructions }] : []),
    ...(typeof input === 'string' ? [{ role: 'user' as const, content: input }] : input.messages),
  ];
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const params = Object.fromEntries(PARAM_KEYS.filter((k) => agent.params?.[k] !== undefined).map((k) => [k, agent.params![k]]));
  const extra = Object.fromEntries(Object.entries(agent.params ?? {}).filter(([k]) => !(PARAM_KEYS as readonly string[]).includes(k)));
  const end = (status: RunResult['status'], output: string, reason?: string): RunResult =>
    ({ runId: ctx.runId, status, output, usage, ...(reason ? { reason } : {}) });

  yield { type: 'run_start', runId: ctx.runId, agent: agent.name };
  try {
    const specs = agent.tools.length ? await tools.listTools(ctx) : [];
    for (let turn = 1; turn <= (opts.maxTurns ?? 8); turn++) {
      if (ctx.signal?.aborted) return end('stopped', '', 'aborted');
      const res = await model.chat({
        model: agent.model, messages, ...(specs.length ? { tools: toChatTools(specs) } : {}), ...params,
        ...(Object.keys(extra).length ? { extra } : {}),
      }, ctx);
      usage.prompt_tokens += res.usage?.prompt_tokens ?? 0;
      usage.completion_tokens += res.usage?.completion_tokens ?? 0;
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      const msg = res.choices[0]?.message ?? { role: 'assistant' as const, content: '' };
      const calls = msg.tool_calls ?? [];
      yield { type: 'model_response', turn, model: res.model, finish_reason: res.choices[0]?.finish_reason ?? null, toolCalls: calls.length };
      messages.push({ role: 'assistant', content: msg.content, ...(calls.length ? { tool_calls: calls } : {}) });
      if (!calls.length) {
        const output = msg.content ?? '';
        if (output) yield { type: 'text', text: output };
        return end('completed', output);
      }
      for (const call of calls) {
        yield { type: 'tool_call', id: call.id, name: call.function.name };
        let args: Record<string, unknown>;
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) as Record<string, unknown> : {};
        } catch {
          args = {};
        }
        const out = call.function.arguments && !isJsonObject(call.function.arguments)
          ? { content: 'Arguments must be a JSON object', isError: true }
          : await tools.callTool(call.function.name, args, ctx);
        yield { type: 'tool_result', id: call.id, name: call.function.name, isError: !!out.isError };
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.content });
      }
    }
    return end('stopped', '', 'max_turns');
  } catch (err) {
    if (err instanceof GuardrailBlocked) return end('stopped', '', err.message);
    if (ctx.signal?.aborted) return end('stopped', '', 'aborted');
    return end('failed', '', err instanceof Error ? err.message : String(err));
  }
}

function isJsonObject(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text);
    return !!v && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}
