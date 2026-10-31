import { GuardrailBlocked } from '../errors.ts';
import { boundExt } from '../ext.ts';
import { assembleDeltas, newUserMessageIndexes, replyToDeltas } from '../messages.ts';
import { ATTR, EVENT, METRIC, SPAN } from '../names.ts';
import type { CallContext } from '../ports/base.ts';
import type { CachePort, RouterPort } from '../ports/cache.ts';
import type { GuardPort, GuardStage } from '../ports/guard.ts';
import type { ModelDelta, ModelPort, ModelReply, ModelRequest, Part } from '../ports/model.ts';
import type { Span, TelemetryPort } from '../ports/telemetry.ts';
import { noopTelemetry } from '../telemetry.ts';
import { sha256, stableStringify } from '../util.ts';
import { guardsFor, runGuards } from './guards.ts';
import { spanStream } from './span-stream.ts';

/** Who shares a cached model reply (`pipeline.cacheScope`). */
export type CacheScope = 'caller' | 'shared';

/** Cache key of a guarded request. The caller is part of it unless the scope is `shared`. */
export function modelCacheKey(req: ModelRequest, ctx: CallContext, scope: CacheScope = 'caller'): string {
  const keyed = scope === 'shared' ? req : { caller: ctx.caller ? `${ctx.caller.kind}:${ctx.caller.id}` : 'anonymous', req };
  return `model:${sha256(stableStringify(keyed))}`;
}

export interface GuardedModelOptions {
  /** Guards; those covering `input` and `output` run here. */
  guards?: readonly GuardPort[];
  /** Reply cache. */
  cache?: CachePort;
  cacheTtlMs?: number;
  /**
   * Who shares a cached reply. `caller` (default): the key includes the caller id (`anonymous` without one), so an
   * answer built from one caller's knowledge is never served to another. `shared`: one entry for every caller.
   */
  cacheScope?: CacheScope;
  /** Model selection. */
  router?: RouterPort;
  /** Telemetry; falls back to `ctx.telemetry`. */
  telemetry?: TelemetryPort;
  /** Largest `ext` bag kept on a reply (`limits.extBytes`); larger ones are dropped with an event. */
  extBytes?: number;
}

/**
 * Wraps a ModelPort with the layers around a model call, in this order:
 * input guards (new user content) → cache lookup → router → model → cache store → output guards.
 * The cache stores the raw model reply, so output guards also run on cache hits. Its key includes the caller unless
 * `cacheScope` is `shared`: knowledge is injected after the cache lookup and may differ per caller.
 * Output guards see every text a caller can be shown: text parts and reasoning parts.
 * A block throws GuardrailBlocked; a redact rewrites the text. Every step is a span with its `agent.layer`.
 * Streaming with output guards buffers the stream, because the full text is needed before it can be released.
 */
export function guardedModel(model: ModelPort, opts: GuardedModelOptions = {}): ModelPort {
  const guards = opts.guards ?? [];
  const tel = (ctx: CallContext) => opts.telemetry ?? ctx.telemetry ?? noopTelemetry;
  const bound = (reply: ModelReply, t: TelemetryPort): ModelReply => opts.extBytes === undefined ? reply
    : boundExt(reply, opts.extBytes, (bytes) => t.event(EVENT.extDropped, { [ATTR.layer]: 'llm', [ATTR.extBytes]: bytes, [ATTR.extShape]: 'ModelReply' }));

  async function prepare(req: ModelRequest, ctx: CallContext): Promise<{ req: ModelRequest; key?: string; cached?: ModelReply }> {
    const t = tel(ctx);
    const guarded = await guardInput(req, guards, ctx, t);
    if (!opts.cache) return { req: guarded };
    const cache = opts.cache;
    const key = modelCacheKey(guarded, ctx, opts.cacheScope);
    const cached = await t.span(SPAN.cacheLookup, { [ATTR.layer]: 'cache' }, async (span) => {
      const hit = await cache.get(key).catch(() => undefined);
      span.setAttributes({ [ATTR.cacheHit]: hit !== undefined });
      return hit as ModelReply | undefined;
    });
    return { req: guarded, key, ...(cached ? { cached } : {}) };
  }

  async function route(req: ModelRequest, ctx: CallContext): Promise<ModelRequest> {
    if (!opts.router) return req;
    const router = opts.router;
    const chosen = await tel(ctx).span(SPAN.routerSelect, { [ATTR.layer]: 'cache', [ATTR.modelRequested]: req.model }, async (span) => {
      const m = await router.select(req, ctx);
      span.setAttributes({ [ATTR.routerModel]: m });
      return m;
    });
    return chosen && chosen !== req.model ? { ...req, model: chosen } : req;
  }

  async function store(key: string | undefined, reply: ModelReply): Promise<void> {
    if (key && opts.cache) await opts.cache.set(key, reply, opts.cacheTtlMs ? { ttlMs: opts.cacheTtlMs } : undefined).catch(() => {});
  }

  return {
    name: model.name ?? 'model',
    native: () => model.native?.() ?? model,
    async chat(req, ctx) {
      const p = await prepare(req, ctx);
      let reply = p.cached;
      if (!reply) {
        const routed = await route(p.req, ctx);
        reply = await tel(ctx).span(SPAN.modelCall, callAttrs(routed), async (span) => {
          const r = bound(await model.chat(routed, ctx), tel(ctx));
          recordUsage(span, r, tel(ctx));
          return r;
        });
        await store(p.key, reply);
      }
      return guardOutput(reply, guards, ctx, tel(ctx));
    },
    async *stream(req, ctx) {
      const p = await prepare(req, ctx);
      if (p.cached) {
        yield* replyToDeltas(await guardOutput(p.cached, guards, ctx, tel(ctx)));
        return;
      }
      const routed = await route(p.req, ctx);
      const source = () => (model.stream ? model.stream(routed, ctx) : deltasOf(model.chat(routed, ctx)));
      const deltas: ModelDelta[] = [];
      const buffer = guardsFor(guards, 'output').length > 0;
      const t = tel(ctx);
      for await (const d of spanStream(t, SPAN.modelCall, callAttrs(routed), source, (span) => recordUsage(span, assembleDeltas(deltas, routed.model), t))) {
        deltas.push(d);
        if (!buffer) yield d;
      }
      const full = bound(assembleDeltas(deltas, routed.model), t);
      await store(p.key, full);
      if (buffer) yield* replyToDeltas(await guardOutput(full, guards, ctx, t));
    },
  };
}

async function* deltasOf(reply: Promise<ModelReply>): AsyncGenerator<ModelDelta> {
  yield* replyToDeltas(await reply);
}

function callAttrs(req: ModelRequest) {
  return { [ATTR.layer]: 'llm' as const, [ATTR.modelRequested]: req.model };
}

function recordUsage(span: Span, reply: ModelReply, t: TelemetryPort): void {
  span.setAttributes({
    [ATTR.modelUsed]: reply.model,
    [ATTR.tokensInput]: reply.usage?.inputTokens,
    [ATTR.tokensOutput]: reply.usage?.outputTokens,
    [ATTR.modelFinish]: String(reply.finish),
  });
  if (reply.usage) {
    t.metric(METRIC.modelTokens, reply.usage.inputTokens, { [ATTR.layer]: 'llm', [ATTR.tokensKind]: 'input', [ATTR.modelUsed]: reply.model });
    t.metric(METRIC.modelTokens, reply.usage.outputTokens, { [ATTR.layer]: 'llm', [ATTR.tokensKind]: 'output', [ATTR.modelUsed]: reply.model });
  }
}

async function guardText(text: string, stage: GuardStage, guards: readonly GuardPort[], ctx: CallContext, t: TelemetryPort): Promise<string> {
  const out = await runGuards(guards, stage, text, ctx, t);
  if (out.action === 'block') throw new GuardrailBlocked(out.guard ?? 'guard', stage, out.reason);
  return out.text;
}

/** Parts whose text a guard reads: text and reasoning. */
const GUARDED_PARTS: ReadonlySet<string> = new Set(['text', 'reasoning']);
const guardedText = (part: Part): string | undefined =>
  GUARDED_PARTS.has(part.type) && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : undefined;

/** Guards the text and reasoning parts of a list of parts, one by one. */
async function guardParts(parts: readonly Part[], stage: GuardStage, guards: readonly GuardPort[], ctx: CallContext, t: TelemetryPort): Promise<Part[]> {
  const out: Part[] = [];
  for (const part of parts) {
    if (guardedText(part) !== undefined) {
      const text = (part as { text: string }).text;
      const guarded = await guardText(text, stage, guards, ctx, t);
      out.push(guarded === text ? part : { ...part, text: guarded } as Part);
    } else out.push(part);
  }
  return out;
}

async function guardInput(req: ModelRequest, guards: readonly GuardPort[], ctx: CallContext, t: TelemetryPort): Promise<ModelRequest> {
  if (!guardsFor(guards, 'input').length) return req;
  const messages = [...req.messages];
  for (const i of newUserMessageIndexes(messages)) {
    const msg = messages[i]!;
    messages[i] = { ...msg, parts: await guardParts(msg.parts, 'input', guards, ctx, t) };
  }
  return { ...req, messages };
}

async function guardOutput(reply: ModelReply, guards: readonly GuardPort[], ctx: CallContext, t: TelemetryPort): Promise<ModelReply> {
  if (!guardsFor(guards, 'output').length || !reply.message.parts.some((p) => guardedText(p))) return reply;
  return { ...reply, message: { ...reply.message, parts: await guardParts(reply.message.parts, 'output', guards, ctx, t) } };
}
