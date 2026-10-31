import {
  contentText, defineAdapter, limitProperties, limitValue, PORT_VERSIONS, type CallContext, type ChatChunk, type ChatRequest, type ChatResponse, type ModelPort, type Usage,
} from '@agent-layers/core';
import { compileRules, decide, LIMITS, type Decision, type MockRule } from './script.ts';

export { LIMITS, type MockRule } from './script.ts';

export interface MockModelOptions {
  /** Model id reported in responses (default `mock`). */
  model?: string;
  /** Scripted answers, first match wins. */
  rules?: MockRule[];
  /** Delay before each answer (default 0). */
  latencyMs?: number;
  /** Characters of a tool result the model repeats as its answer (default 500). */
  toolResultChars?: number;
}

const abortError = () => new DOMException('This operation was aborted', 'AbortError');

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const tokens = (chars: number) => Math.ceil(chars / 4);

/** Deterministic model for offline development and tests: no network, no randomness. */
export function createMockModel(options: MockModelOptions = {}, name = 'mock-model'): ModelPort {
  const model = options.model ?? 'mock';
  const rules = compileRules(options.rules);
  const latencyMs = limitValue(LIMITS.latencyMs, options.latencyMs);
  const toolResultChars = limitValue(LIMITS.toolResultChars, options.toolResultChars);
  let seq = 0;

  async function answer(req: ChatRequest, ctx: CallContext): Promise<{ decision: Decision; response: ChatResponse }> {
    await wait(latencyMs, ctx.signal);
    const decision = decide(req, rules, toolResultChars);
    const n = ++seq;
    const { call } = decision;
    const promptChars = req.messages.reduce((sum, m) => sum + contentText(m.content).length, 0);
    const outputChars = (decision.content?.length ?? 0) + (call ? call.name.length + call.arguments.length : 0);
    const usage: Usage = { prompt_tokens: tokens(promptChars), completion_tokens: tokens(outputChars) };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    const message: ChatResponse['choices'][number]['message'] = { role: 'assistant', content: decision.content };
    if (call) message.tool_calls = [{ id: `call_${n}`, type: 'function', function: call }];
    return {
      decision,
      response: { id: `mock-${n}`, model, choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage },
    };
  }

  return {
    name,
    chat: async (req, ctx) => (await answer(req, ctx)).response,
    async *stream(req, ctx): AsyncGenerator<ChatChunk> {
      const { response } = await answer(req, ctx);
      const choice = response.choices[0]!;
      const base = { ...(response.id ? { id: response.id } : {}), model };
      let first = true;
      for (const word of choice.message.content?.match(/\s*\S+|\s+/g) ?? []) {
        if (ctx.signal?.aborted) throw abortError();
        yield { ...base, choices: [{ index: 0, delta: { ...(first ? { role: 'assistant' as const } : {}), content: word } }] };
        first = false;
      }
      const calls = choice.message.tool_calls ?? [];
      if (calls.length) {
        yield { ...base, choices: [{ index: 0, delta: { ...(first ? { role: 'assistant' as const } : {}), tool_calls: calls.map((c, index) => ({ index, ...c })) } }] };
      }
      yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], ...(response.usage ? { usage: response.usage } : {}) };
    },
  };
}

export const adapter = defineAdapter<'ModelPort', MockModelOptions>({
  layer: 'llm',
  port: 'ModelPort',
  name: 'mock-model',
  direction: 'outbound',
  maps: { technology: 'scripted deterministic model' },
  portVersion: PORT_VERSIONS.ModelPort,
  tiers: ['prototype'],
  description: 'Offline model that answers from scripted rules, retrieved passages or an echo. For development and tests.',
  optionsSchema: {
    type: 'object',
    properties: {
      model: { type: 'string', minLength: 1 },
      rules: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            match: { type: 'string' },
            tool: { type: 'string', minLength: 1 },
            args: { type: 'object' },
            reply: { type: 'string' },
          },
          required: ['match'],
          additionalProperties: false,
        },
      },
      ...limitProperties(LIMITS, { latencyMs: 'Delay before each answer', toolResultChars: 'Characters of a tool result the model repeats as its answer' }),
    },
    additionalProperties: false,
  },
  limits: LIMITS,
  create: (options, ctx) => createMockModel(options, ctx.name),
});

export const adapters = [adapter];
