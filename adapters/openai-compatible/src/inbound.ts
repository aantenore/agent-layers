import { randomUUID } from 'node:crypto';
import {
  GuardrailBlocked, MissingLayerError, responseToChunks,
  type CallContext, type ChannelHost, type ChannelPort, type ChatChunk, type ChatMessage, type ChatRequest, type ChatResponse,
  type InboundContext, type InboundRoute, type RunEvent, type Usage,
} from '@agent-layers/core';

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

/** Request fields passed on to the model untouched. Anything else is dropped, so a caller cannot replace the guarded messages or the model. */
const PASSTHROUGH = ['response_format', 'seed', 'top_p', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'user', 'parallel_tool_calls', 'reasoning_effort', 'max_completion_tokens'];
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const AGENT_PREFIX = 'agent:';

class BadRequest extends Error {}

const isJson = (req: Request) => /^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '');

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });
const error = (status: number, message: string, type: string, code?: string) => json({ error: { message, type, param: null, code: code ?? null } }, status);
const now = () => Math.floor(Date.now() / 1000);
const usageOf = (u: Usage | undefined) => (u ? { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens ?? u.prompt_tokens + u.completion_tokens } : undefined);

interface Parsed { model: string; stream: boolean; includeUsage: boolean; req: Omit<ChatRequest, 'model'> }

/** Validates the Chat Completions body into the core request shape. */
export function parseChatBody(body: unknown): Parsed {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('the body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.model !== 'string' || !b.model) throw new BadRequest('model is required');
  if (!Array.isArray(b.messages) || !b.messages.length) throw new BadRequest('messages must be a non-empty array');
  for (const [i, m] of b.messages.entries()) {
    if (!m || typeof m !== 'object' || !ROLES.has((m as { role?: string }).role ?? '')) throw new BadRequest(`messages[${i}]: unknown role`);
    if (!('content' in m) && (m as { role: string }).role !== 'assistant') throw new BadRequest(`messages[${i}]: content is required`);
  }
  const num = (k: string) => (typeof b[k] === 'number' ? { [k]: b[k] as number } : {});
  const stop = typeof b.stop === 'string' ? [b.stop] : Array.isArray(b.stop) ? b.stop.filter((s): s is string => typeof s === 'string') : undefined;
  const extra = Object.fromEntries(PASSTHROUGH.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
  const opts = b.stream_options as { include_usage?: unknown } | undefined;
  return {
    model: b.model,
    stream: b.stream === true,
    includeUsage: opts?.include_usage === true,
    req: {
      messages: b.messages as ChatMessage[],
      ...(Array.isArray(b.tools) ? { tools: b.tools as ChatRequest['tools'] } : {}),
      ...(b.tool_choice !== undefined ? { tool_choice: b.tool_choice as ChatRequest['tool_choice'] } : {}),
      ...num('temperature'), ...num('max_tokens'),
      ...(stop?.length ? { stop } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    },
  };
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

/** Error body for a failure; never the error's own text, which can carry upstream bodies or credentials. */
function errorBody(err: unknown): { message: string; type: string; code: string | null } {
  if (err instanceof GuardrailBlocked) return { message: err.message, type: 'invalid_request_error', code: 'content_filter' };
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
export function createOpenAICompatibleChannel(options: OpenAICompatibleChannelOptions = {}, name = 'openai-compatible'): ChannelPort {
  const base = `/${(options.basePath ?? '/v1').replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
  const aliases = options.models ?? {};
  const ownedBy = options.ownedBy ?? 'agent-layers';

  return {
    name,
    mount(host: ChannelHost) {
      const agents = () => {
        if (options.agents === false) return [];
        const all = host.agents();
        return Array.isArray(options.agents) ? all.filter((a) => (options.agents as string[]).includes(a)) : all;
      };
      const context = (ctx: InboundContext): CallContext => ({
        runId: randomUUID(), agent: name, signal: ctx.signal, ...(ctx.identity ? { identity: ctx.identity } : {}),
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
        const req: ChatRequest = { ...p.req, model: aliases[alias]! };
        const call = context(ctx);
        const id = `chatcmpl-${call.runId}`;
        const created = now();
        if (!p.stream) {
          let res: ChatResponse;
          try { res = await model.chat(req, call); } catch (err) { return failure(err); }
          return json({
            id, object: 'chat.completion', created, model: alias,
            choices: res.choices.map((c) => ({ index: c.index, message: { role: 'assistant', content: c.message.content, ...(c.message.tool_calls?.length ? { tool_calls: c.message.tool_calls } : {}) }, finish_reason: c.finish_reason ?? 'stop', logprobs: null })),
            ...(res.usage ? { usage: usageOf(res.usage) } : {}),
          });
        }
        const source = model.stream ? model.stream(req, call) : (async function* () { yield* responseToChunks(await model.chat(req, call)); })();
        let start: { first: ChatChunk[]; rest: AsyncIterable<ChatChunk> };
        try { start = await primed(source); } catch (err) { return failure(err); }
        const wire = (chunk: ChatChunk) => ({
          id, object: 'chat.completion.chunk', created, model: alias,
          choices: chunk.choices.map((c) => ({ index: c.index, delta: c.delta, finish_reason: c.finish_reason ?? null, logprobs: null })),
        });
        async function* frames(): AsyncGenerator<unknown> {
          let usage: Usage | undefined;
          for (const chunk of start.first) { usage = chunk.usage ?? usage; if (chunk.choices.length) yield wire(chunk); }
          for await (const chunk of start.rest) { usage = chunk.usage ?? usage; if (chunk.choices.length) yield wire(chunk); }
          if (p.includeUsage) yield { id, object: 'chat.completion.chunk', created, model: alias, choices: [], usage: usageOf(usage) ?? null };
        }
        return sse(frames());
      }

      async function viaAgent(agent: string, p: Parsed, ctx: InboundContext): Promise<Response> {
        const call = context(ctx);
        const id = `chatcmpl-${call.runId}`;
        const created = now();
        const model = `${AGENT_PREFIX}${agent}`;
        const input = { messages: p.req.messages };
        const run = { runId: call.runId, signal: ctx.signal, ...(ctx.identity ? { identity: ctx.identity } : {}) };
        const headers = { 'x-agent-run-id': call.runId };
        const finish = (status: string) => (status === 'completed' ? 'stop' : status === 'stopped' ? 'content_filter' : 'error');
        if (!p.stream || !host.stream) {
          const r = await host.run(agent, input, run);
          if (r.status !== 'completed' && r.status !== 'stopped') return json({ error: { message: 'the agent run failed', type: 'server_error', param: null, code: null } }, 500, headers);
          const body = {
            id, object: 'chat.completion', created, model,
            choices: [{ index: 0, message: { role: 'assistant', content: r.status === 'completed' ? r.output : '' }, finish_reason: finish(r.status), logprobs: null }],
            ...(r.usage ? { usage: usageOf(r.usage) } : {}),
          };
          if (!p.stream) return json(body, 200, headers);
          const chunk = (delta: unknown, finish_reason: string | null) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason, logprobs: null }] });
          return withHeaders(sse((async function* () {
            yield chunk({ role: 'assistant', content: body.choices[0]!.message.content }, null);
            yield chunk({}, body.choices[0]!.finish_reason);
            if (p.includeUsage) yield { id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOf(r.usage) ?? null };
          })()), headers);
        }
        const stream = host.stream;
        async function* frames(): AsyncGenerator<unknown> {
          const chunk = (delta: unknown, finish_reason: string | null) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason, logprobs: null }] });
          let sent = false;
          let usage: Usage | undefined;
          let status = 'completed';
          for await (const e of stream(agent, input, run) as AsyncIterable<RunEvent>) {
            if (e.type === 'text' && typeof e.text === 'string' && e.text) {
              yield chunk({ ...(sent ? {} : { role: 'assistant' }), content: e.text }, null);
              sent = true;
            } else if (e.type === 'run_end') {
              status = String(e.status ?? 'completed');
              usage = (e.usage as Usage | undefined) ?? usage;
              if (!sent && status === 'completed' && typeof e.output === 'string' && e.output) yield chunk({ role: 'assistant', content: e.output }, null);
            }
          }
          if (status !== 'completed' && status !== 'stopped') throw new Error('agent run failed');
          yield chunk({}, finish(status));
          if (p.includeUsage) yield { id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageOf(usage) ?? null };
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
            parsed = parseChatBody(await req.json().catch(() => { throw new BadRequest('the body is not valid JSON'); }));
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
