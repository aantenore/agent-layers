import {
  defineAdapter, limitProperties, limitValue, PORT_VERSIONS, replyToDeltas, type CallContext, type Message, type ModelDelta, type ModelPort, type ModelReply,
  type ModelRequest, type Part,
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

/** Characters of the text a message carries: text, reasoning and result parts. */
const messageChars = (m: Message) =>
  m.parts.reduce((sum, p) => sum + (p.type === 'text' || p.type === 'reasoning' || p.type === 'result' ? String((p as { text?: unknown }).text ?? '').length : 0), 0);

/** Deterministic model for offline development and tests: no network, no randomness. */
export function createMockModel(options: MockModelOptions = {}, name = 'mock-model'): ModelPort {
  const model = options.model ?? 'mock';
  const rules = compileRules(options.rules);
  const latencyMs = limitValue(LIMITS.latencyMs, options.latencyMs);
  const toolResultChars = limitValue(LIMITS.toolResultChars, options.toolResultChars);
  let seq = 0;

  async function answer(req: ModelRequest, ctx: CallContext): Promise<{ decision: Decision; reply: ModelReply }> {
    await wait(latencyMs, ctx.signal);
    const decision = decide(req, rules, toolResultChars);
    const n = ++seq;
    const { call } = decision;
    const promptChars = req.messages.reduce((sum, m) => sum + messageChars(m), 0);
    const outputChars = decision.text.length + (call ? call.tool.length + JSON.stringify(call.args).length : 0);
    const parts: Part[] = [];
    if (decision.text) parts.push({ type: 'text', text: decision.text });
    if (call) parts.push({ type: 'call', id: `call_${n}`, tool: call.tool, args: call.args });
    return {
      decision,
      reply: {
        id: `mock-${n}`, model, message: { role: 'assistant', parts }, finish: call ? 'tools' : 'end',
        usage: { inputTokens: tokens(promptChars), outputTokens: tokens(outputChars) },
      },
    };
  }

  return {
    name,
    chat: async (req, ctx) => (await answer(req, ctx)).reply,
    async *stream(req, ctx): AsyncGenerator<ModelDelta> {
      const { reply } = await answer(req, ctx);
      for (const delta of replyToDeltas(reply)) {
        if (delta.type !== 'text') { yield delta; continue; }
        for (const word of delta.text.match(/\s*\S+|\s+/g) ?? []) {
          if (ctx.signal?.aborted) throw abortError();
          yield { type: 'text', text: word };
        }
      }
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
