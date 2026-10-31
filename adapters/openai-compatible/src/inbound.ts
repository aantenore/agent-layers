import { randomUUID } from 'node:crypto';
import {
  GuardrailBlocked, MissingLayerError, replyToDeltas,
  type CallContext, type ChannelHost, type ChannelPort, type InboundContext, type InboundRoute, type ModelDelta, type ModelReply, type ModelRequest, type RunEvent,
  type RunResult, type Usage, type Vocabularies,
} from '@agent-layers/core';
import { ChunkWriter, defaultRole, replyOut, requestIn, usageOut, WireError } from './wire.ts';

/** Options of the inbound descriptor. */
export interface OpenAICompatibleChannelOptions {
  /** Path prefix of the API (default `/v1`). */
  basePath?: string;
  /** Model aliases callers may name → model id sent to the stack's governed model. */
  models?: Record<string, string>;
  /** Agents callers may name as `agent:<name>`: all of the stack's agents (default), none (`false`) or a list. */
  agents?: boolean | string[];
  /** `owned_by` in the model list (default `agent-layers`). */
  ownedBy?: string;
}

const AGENT_PREFIX = 'agent:';

class BadRequest extends Error {}

const isJson = (req: Request) => /^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '');

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });
const error = (status: number, message: string, type: string, code?: string) => json({ error: { message, type, param: null, code: code ?? null } }, status);
const now = () => Math.floor(Date.now() / 1000);

interface Parsed { model: string; stream: boolean; includeUsage: boolean; req: Omit<ModelRequest, 'model'> }

/**
 * Validates a Chat Completions body and translates it into a language request. Only known fields cross: the
 * passthrough fields become `ext["openai.*"]`; anything else is dropped, so a caller cannot replace the guarded
 * messages or the model. `resolveRole` maps wire roles to language roles (`developer` → `system`, configured aliases).
 */
export function parseChatBody(body: unknown, resolveRole: (role: string) => string = defaultRole): Parsed {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('the body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.model !== 'string' || !b.model) throw new BadRequest('model is required');
  if (!Array.isArray(b.messages) || !b.messages.length) throw new BadRequest('messages must be a non-empty array');
  for (const [i, m] of b.messages.entries()) {
    if (!m || typeof m !== 'object' || typeof (m as { role?: unknown }).role !== 'string') throw new BadRequest(`messages[${i}]: unknown role`);
    if (!('content' in m) && (m as { role: string }).role !== 'assistant') throw new BadRequest(`messages[${i}]: content is required`);
  }
  let req: ModelRequest;
  try {
    req = requestIn(b, resolveRole);
  } catch (err) {
    if (err instanceof WireError) throw new BadRequest(err.message);
    throw err;
  }
  const { model: _model, ...rest } = req;
  const opts = b.stream_options as { include_usage?: unknown } | undefined;
  return { model: b.model, stream: b.stream === true, includeUsage: opts?.include_usage === true, req: rest };
}

/** Server-Sent Events in the Chat Completions format, ending with `data: [DONE]`. */
function sse(events: AsyncIterable<unknown>): Response {
  const enc = new TextEncoder();
  const frame = (v: unknown) => enc.encode(`data: ${JSON.stringify(v)}\n\n`);
  const it = events[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const step = await it.next();
        if (step.done) {
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        } else controller.enqueue(frame(step.value));
      } catch (err) {
        controller.enqueue(frame({ error: errorBody(err) }));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
    async cancel() { await it.return?.(); },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' } });
}

/** Error body for a failure; never the error's own text, which can carry upstream bodies, credentials or guard names. */
function errorBody(err: unknown): { message: string; type: string; code: string | null } {
  if (err instanceof GuardrailBlocked) return { message: 'the request was blocked by a guardrail', type: 'invalid_request_error', code: 'content_filter' };
  if (err instanceof MissingLayerError) return { message: 'no model is configured', type: 'server_error', code: null };
  return { message: 'the model call failed', type: 'api_error', code: null };
}

function failure(err: unknown): Response {
  const e = errorBody(err);
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return error(504, 'request cancelled or timed out', 'timeout_error');
  return json({ error: { ...e, param: null } }, e.code === 'content_filter' ? 400 : e.type === 'server_error' ? 503 : 502);
}

/** Reads the first item, so failures before any output become a plain error response instead of a broken stream. */
async function primed<T>(source: AsyncIterable<T>): Promise<{ first: T[]; rest: AsyncIterable<T> }> {
  const it = source[Symbol.asyncIterator]();
  const step = await it.next();
  const rest = { [Symbol.asyncIterator]: () => it };
  return { first: step.done ? [] : [step.value], rest };
}

/** Exposes the stack through the OpenAI Chat Completions API: model aliases (governed model) and `agent:<name>` (agent runs). */
export function createOpenAICompatibleChannel(
  options: OpenAICompatibleChannelOptions = {},
  name = 'openai-compatible',
  vocabularies: () => Vocabularies | undefined = () => undefined,
): ChannelPort {
  const base = `/${(options.basePath ?? '/v1').replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
  const aliases = options.models ?? {};
  const ownedBy = options.ownedBy ?? 'agent-layers';
  /** Configured role aliases first, then `developer` → `system`. */
  const resolveRole = (role: string) => defaultRole(vocabularies()?.resolve('role', role) ?? role);
  /** A configured finish value as the core value it is like. */
  const coreFinish = (finish: string) => vocabularies()?.core('finish', finish);

  return {
    name,
    mount(host: ChannelHost) {
      const agents = () => {
        if (options.agents === false) return [];
        const all = host.agents();
        return Array.isArray(options.agents) ? all.filter((a) => (options.agents as string[]).includes(a)) : all;
      };
      const context = (ctx: InboundContext): CallContext => ({
        runId: randomUUID(), agent: name, signal: ctx.signal, ...(ctx.caller ? { caller: ctx.caller } : {}), ...(ctx.trace ? { trace: ctx.trace } : {}),
      });

      const listModels: InboundRoute = {
        path: `${base}/models`,
        methods: ['GET'],
        handle: async () => json({
          object: 'list',
          data: [...Object.keys(aliases), ...agents().map((a) => `${AGENT_PREFIX}${a}`)].map((id) => ({ id, object: 'model', created: 0, owned_by: ownedBy })),
        }),
      };

      async function viaModel(alias: string, p: Parsed, ctx: InboundContext): Promise<Response> {
        if (!host.model) return error(503, 'no model is configured', 'server_error');
        const model = host.model();
        const req: ModelRequest = { ...p.req, model: aliases[alias]! };
        const call = context(ctx);
        const id = `chatcmpl-${call.runId}`;
        const created = now();
        if (!p.stream) {
          let reply: ModelReply;
          try { reply = await model.chat(req, call); } catch (err) { return failure(err); }
          return json(replyOut(reply, { id, object: 'chat.completion', created, model: alias }, coreFinish));
        }
        const source = model.stream ? model.stream(req, call) : (async function* () { yield* replyToDeltas(await model.chat(req, call)); })();
        let start: { first: ModelDelta[]; rest: AsyncIterable<ModelDelta> };
        try { start = await primed(source); } catch (err) { return failure(err); }
        const writer = new ChunkWriter({ id, created, model: alias }, { includeUsage: p.includeUsage, core: coreFinish });
        async function* frames(): AsyncGenerator<unknown> {
          for (const d of start.first) yield* writer.write(d);
          for await (const d of start.rest) yield* writer.write(d);
        }
        return sse(frames());
      }

      /**
       * Run result → wire: `completed` and `waiting` (the output so far; the run can be resumed) → `stop`; `stopped` →
       * `content_filter` with no output (the reason stays inside); `failed` → HTTP 500.
       */
      const finishOfRun = (status: RunResult['status']) => (status === 'stopped' ? 'content_filter' : 'stop');
      const answered = (status: RunResult['status']) => status !== 'failed';

      async function viaAgent(agent: string, p: Parsed, ctx: InboundContext): Promise<Response> {
        const call = context(ctx);
        const id = `chatcmpl-${call.runId}`;
        const created = now();
        const model = `${AGENT_PREFIX}${agent}`;
        const input = { messages: p.req.messages };
        const run = { runId: call.runId, signal: ctx.signal, ...(ctx.caller ? { caller: ctx.caller } : {}), ...(ctx.trace ? { trace: ctx.trace } : {}) };
        const headers = { 'x-agent-run-id': call.runId };
        const chunk = (delta: unknown, finish_reason: string | null) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason, logprobs: null }] });
        const usageChunk = (usage: Usage | undefined) => ({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOut(usage) ?? null });
        if (!p.stream || !host.stream) {
          const r = await host.run(agent, input, run);
          if (!answered(r.status)) return json({ error: { message: 'the agent run failed', type: 'server_error', param: null, code: null } }, 500, headers);
          const content = r.status === 'stopped' ? '' : r.output;
          const usage = usageOut(r.usage);
          const body = {
            id, object: 'chat.completion', created, model,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishOfRun(r.status), logprobs: null }],
            ...(usage ? { usage } : {}),
          };
          if (!p.stream) return json(body, 200, headers);
          return withHeaders(sse((async function* () {
            yield chunk({ role: 'assistant', content }, null);
            yield chunk({}, finishOfRun(r.status));
            if (p.includeUsage) yield usageChunk(r.usage);
          })()), headers);
        }
        const stream = host.stream;
        async function* frames(): AsyncGenerator<unknown> {
          let sent = false;
          let usage: Usage | undefined;
          let status: RunResult['status'] = 'completed';
          for await (const e of stream(agent, input, run) as AsyncIterable<RunEvent>) {
            if (e.type === 'text' && typeof e.text === 'string' && e.text) {
              yield chunk({ ...(sent ? {} : { role: 'assistant' }), content: e.text }, null);
              sent = true;
            } else if (e.type === 'run.end') {
              status = (e as Extract<RunEvent, { type: 'run.end' }>).status;
              usage = (e as Extract<RunEvent, { type: 'run.end' }>).usage ?? usage;
            }
          }
          if (!answered(status)) throw new Error('agent run failed');
          yield chunk(sent ? {} : { role: 'assistant' }, finishOfRun(status));
          if (p.includeUsage) yield usageChunk(usage);
        }
        return withHeaders(sse(frames()), headers);
      }

      const completions: InboundRoute = {
        path: `${base}/chat/completions`,
        methods: ['POST'],
        async handle(req, ctx) {
          if (!isJson(req)) return error(415, 'Content-Type must be application/json', 'invalid_request_error');
          let parsed: Parsed;
          try {
            parsed = parseChatBody(await req.json().catch(() => { throw new BadRequest('the body is not valid JSON'); }), resolveRole);
          } catch (err) {
            if (err instanceof BadRequest) return error(400, err.message, 'invalid_request_error');
            throw err;
          }
          if (parsed.model.startsWith(AGENT_PREFIX)) {
            const agent = parsed.model.slice(AGENT_PREFIX.length);
            if (!agents().includes(agent)) return error(404, `The model \`${parsed.model}\` does not exist`, 'invalid_request_error', 'model_not_found');
            return viaAgent(agent, parsed, ctx);
          }
          if (!Object.hasOwn(aliases, parsed.model)) return error(404, `The model \`${parsed.model}\` does not exist`, 'invalid_request_error', 'model_not_found');
          return viaModel(parsed.model, parsed, ctx);
        },
      };

      return { routes: [listModels, completions] };
    },
  };
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}
