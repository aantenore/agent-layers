import { contentText, newUserMessageIndexes, responseToChunks, assembleChunks } from '../chat.ts';
import { GuardrailBlocked } from '../errors.ts';
import type { CallContext } from '../ports/base.ts';
import type { CachePort, RouterPort } from '../ports/cache.ts';
import type { GuardPort, GuardStage } from '../ports/guard.ts';
import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, ContentPart, ModelPort } from '../ports/model.ts';
import type { Span, TelemetryPort } from '../ports/telemetry.ts';
import { noopTelemetry } from '../telemetry.ts';
import { sha256, stableStringify } from '../util.ts';
import { guardsFor, runGuards } from './guards.ts';
import { spanStream } from './span-stream.ts';

export interface GuardedModelOptions {
  /** Guards; those covering `input` and `output` run here. */
  guards?: readonly GuardPort[];
  /** Response cache. */
  cache?: CachePort;
  cacheTtlMs?: number;
  /** Model selection. */
  router?: RouterPort;
  /** telemetry;falls back to `ctx.telemetry`. */
  telemetry?: TelemetryPort;
}

/**
 * Wraps a ModelPort with the layers around a model call, in this order:
 * input guards (new user content) → cache lookup → router → model → cache store → output guards.
 * The cache stores the raw model response, so output guards also run on cache hits.
 * A block throws GuardrailBlocked; a redact rewrites the text. Every step is a span with its `agent.layer`.
 * Streaming with output guards buffers the stream, because the full text is needed before it can be released.
 */
export function guardedModel(model: ModelPort, opts: GuardedModelOptions = {}): ModelPort {
  const guards = opts.guards ?? [];
  const tel = (ctx: CallContext) => opts.telemetry ?? ctx.telemetry ?? noopTelemetry;

  async function prepare(req: ChatRequest, ctx: CallContext): Promise<{ req: ChatRequest; key?: string; cached?: ChatResponse }> {
    const t = tel(ctx);
    const guarded = await guardInput(req, guards, ctx, t);
    if (!opts.cache) return { req: guarded };
    const cache = opts.cache;
    const key = `chat:${sha256(stableStringify({ ...guarded, stream: undefined }))}`;
    const cached = await t.span('cache.lookup', { 'agent.layer': 'cache' }, async (span) => {
      const hit = await cache.get(key).catch(() => undefined);
      span.setAttributes({ 'cache.hit': hit !== undefined });
      return hit as ChatResponse | undefined;
    });
    return { req: guarded, key, ...(cached ? { cached } : {}) };
  }

  async function route(req: ChatRequest, ctx: CallContext): Promise<ChatRequest> {
    if (!opts.router) return req;
    const router = opts.router;
    const chosen = await tel(ctx).span('router.select', { 'agent.layer': 'cache', 'gen_ai.request.model': req.model }, async (span) => {
      const m = await router.select(req, ctx);
      span.setAttributes({ 'router.model': m });
      return m;
    });
    return chosen && chosen !== req.model ? { ...req, model: chosen } : req;
  }

  async function store(key: string | undefined, res: ChatResponse): Promise<void> {
    if (key && opts.cache) await opts.cache.set(key, res, opts.cacheTtlMs ? { ttlMs: opts.cacheTtlMs } : undefined).catch(() => {});
  }

  return {
    name: model.name ?? 'model',
    native: () => model.native?.() ?? model,
    async chat(req, ctx) {
      const p = await prepare(req, ctx);
      let res = p.cached;
      if (!res) {
        const routed = await route(p.req, ctx);
        res = await tel(ctx).span('chat', chatAttrs(routed), async (span) => {
          const r = await model.chat(routed, ctx);
          recordUsage(span, r, tel(ctx));
          return r;
        });
        await store(p.key, res);
      }
      return guardOutput(res, guards, ctx, tel(ctx));
    },
    async *stream(req, ctx) {
      const p = await prepare(req, ctx);
      if (p.cached) {
        yield* responseToChunks(await guardOutput(p.cached, guards, ctx, tel(ctx)));
        return;
      }
      const routed = await route(p.req, ctx);
      const source = () => (model.stream ? model.stream(routed, ctx) : chunksOf(model.chat(routed, ctx)));
      const chunks: ChatChunk[] = [];
      const buffer = guardsFor(guards, 'output').length > 0;
      const t = tel(ctx);
      for await (const chunk of spanStream(t, 'chat', chatAttrs(routed), source, (span) => recordUsage(span, assembleChunks(chunks, routed.model), t))) {
        chunks.push(chunk);
        if (!buffer) yield chunk;
      }
      const full = assembleChunks(chunks, routed.model);
      await store(p.key, full);
      if (buffer) yield* responseToChunks(await guardOutput(full, guards, ctx, t));
    },
  };
}

async function* chunksOf(res: Promise<ChatResponse>): AsyncGenerator<ChatChunk> {
  yield* responseToChunks(await res);
}

function chatAttrs(req: ChatRequest) {
  return { 'agent.layer': 'llm' as const, 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': req.model };
}

function recordUsage(span: Span, res: ChatResponse, t: TelemetryPort): void {
  span.setAttributes({
    'gen_ai.response.model': res.model,
    'gen_ai.usage.input_tokens': res.usage?.prompt_tokens,
    'gen_ai.usage.output_tokens': res.usage?.completion_tokens,
    'gen_ai.response.finish_reasons': res.choices.map((c) => String(c.finish_reason ?? '')),
  });
  if (res.usage) {
    t.metric('gen_ai.client.token.usage', res.usage.prompt_tokens, { 'agent.layer': 'llm', 'gen_ai.token.type': 'input', 'gen_ai.response.model': res.model });
    t.metric('gen_ai.client.token.usage', res.usage.completion_tokens, { 'agent.layer': 'llm', 'gen_ai.token.type': 'output', 'gen_ai.response.model': res.model });
  }
}

async function guardText(text: string, stage: GuardStage, guards: readonly GuardPort[], ctx: CallContext, t: TelemetryPort): Promise<string> {
  const out = await runGuards(guards, stage, text, ctx, t);
  if (out.action === 'block') throw new GuardrailBlocked(out.guard ?? 'guard', stage, out.reason);
  return out.text;
}

async function guardInput(req: ChatRequest, guards: readonly GuardPort[], ctx: CallContext, t: TelemetryPort): Promise<ChatRequest> {
  if (!guardsFor(guards, 'input').length) return req;
  const messages = [...req.messages];
  for (const i of newUserMessageIndexes(messages)) {
    const msg = messages[i] as Extract<ChatMessage, { role: 'user' }>;
    if (typeof msg.content === 'string') {
      const text = await guardText(msg.content, 'input', guards, ctx, t);
      if (text !== msg.content) messages[i] = { ...msg, content: text };
      continue;
    }
    const parts: ContentPart[] = [];
    for (const part of msg.content) {
      parts.push(part.type === 'text' && typeof part.text === 'string' ? { type: 'text', text: await guardText(part.text, 'input', guards, ctx, t) } : part);
    }
    messages[i] = { ...msg, content: parts };
  }
  return { ...req, messages };
}

async function guardOutput(res: ChatResponse, guards: readonly GuardPort[], ctx: CallContext, t: TelemetryPort): Promise<ChatResponse> {
  if (!guardsFor(guards, 'output').length) return res;
  const choices = await Promise.all(res.choices.map(async (c) => {
    const text = contentText(c.message.content);
    if (!text) return c;
    const guarded = await guardText(text, 'output', guards, ctx, t);
    return guarded === text ? c : { ...c, message: { ...c.message, content: guarded } };
  }));
  return { ...res, choices };
}
