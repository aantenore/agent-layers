import { assembleChunks, GuardrailBlocked, type CallContext, type ChatChunk, type ChatResponse, type ModelPort, type ToolPort, type ToolSpec } from '@agent-layers/core';
import { RunStop, type Provider, type Tool } from 'reinloop';
import { fromChatResponse, toChatRequest } from './convert.ts';

/**
 * The stack's governed model as a reinloop Provider. Every call goes through the SDK pipeline (input guards, cache,
 * router, knowledge, output guards, the `chat` span), with the run's call context. A guardrail block ends the run
 * through reinloop's `RunStop`, so the run ends `stopped` with reason `guardrail:<guard>:<stage>`.
 */
export function governedProvider(model: ModelPort, ctx: CallContext, opts: { stream?: boolean } = {}): Provider {
  return {
    name: model.name ?? 'agent-layers',
    async generate(req, g) {
      const chat = toChatRequest(req);
      const call: CallContext = { ...ctx, signal: g.signal };
      let res: ChatResponse;
      try {
        if (opts.stream && g.onText && model.stream) {
          const chunks: ChatChunk[] = [];
          for await (const c of model.stream(chat, call)) {
            chunks.push(c);
            const delta = c.choices[0]?.delta?.content;
            if (delta) g.onText(delta);
          }
          res = assembleChunks(chunks, chat.model);
        } else {
          res = await model.chat(chat, call);
        }
      } catch (err) {
        if (err instanceof GuardrailBlocked) throw new RunStop(err.message);
        throw err;
      }
      return fromChatResponse(res, chat.model);
    },
  };
}

/**
 * One governed SDK tool as a reinloop Tool: name, description, schema, risk and layer pass through; the call goes
 * through the stack's governed tools (policy, approval, authorization, tool guards, bound credentials, the
 * `execute_tool` span). Denials and guard blocks come back as error results, as in any runtime. A GuardrailBlocked
 * thrown by a tool ends the run like a model block: `halt` aborts the batch and `RunStop` sets the reason.
 */
export function governedTool(tools: ToolPort, spec: ToolSpec, ctx: CallContext, halt: AbortController): Tool {
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.inputSchema,
    ...(spec.risk ? { risk: spec.risk } : {}),
    ...(spec.layer ? { layer: spec.layer } : {}),
    async run(args, t) {
      const input = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
      try {
        const out = await tools.callTool(spec.name, input, { ...ctx, signal: t.signal });
        return { content: out.content, ...(out.isError ? { isError: true } : {}) };
      } catch (err) {
        if (!(err instanceof GuardrailBlocked)) throw err;
        const stop = new RunStop(err.message);
        halt.abort(stop);
        throw stop;
      }
    },
  };
}
