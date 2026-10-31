import { anySignal, defineAdapter, defineLimits, limitProperties, limitValue, PORT_VERSIONS, timeoutSignal, traceHeaders, type CallContext, type ChatChunk, type ChatRequest, type ChatResponse, type LimitValue, type ModelPort } from '@agent-layers/core';
import { createOpenAICompatibleChannel, type OpenAICompatibleChannelOptions } from './inbound.ts';
import { sseData } from './sse.ts';

export { createOpenAICompatibleChannel, parseChatBody, type OpenAICompatibleChannelOptions } from './inbound.ts';
import { requestBody, toChunk, toResponse } from './wire.ts';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface OpenAICompatibleOptions {
  /** Endpoint root, for example `http://localhost:11434/v1`. */
  baseUrl: string;
  apiKey?: string;
  /** Model used when the request model is '' or 'default'. */
  model?: string;
  headers?: Record<string, string>;
  /** Whole-request timeout, streams included (default 120000). */
  timeoutMs?: LimitValue;
  /** Ask streaming backends for a final usage chunk (default true). */
  includeUsage?: boolean;
  /** Characters of an error body kept in the error message (default 300). */
  errorBodyChars?: number;
  /** Characters of an invalid stream event kept in the error message (default 100). */
  streamEventChars?: number;
}

/** Configurable limits of the model descriptor; see docs/limits.md. */
export const LIMITS = defineLimits({
  timeoutMs: { path: 'options.timeoutMs', default: 120_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 600_000 } },
  errorBodyChars: { path: 'options.errorBodyChars', default: 300, unit: 'chars', min: 0, max: 100_000, safe: { max: 2000 } },
  streamEventChars: { path: 'options.streamEventChars', default: 100, unit: 'chars', min: 0, max: 100_000, safe: { max: 2000 } },
});

/** Factory: usable directly from code, without the registry. */
export function createOpenAICompatibleModel(options: OpenAICompatibleOptions, name = 'openai-compatible'): ModelPort {
  const base = options.baseUrl.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const timeoutMs = limitValue(LIMITS.timeoutMs, options.timeoutMs);
  const errorBodyChars = limitValue(LIMITS.errorBodyChars, options.errorBodyChars);
  const streamEventChars = limitValue(LIMITS.streamEventChars, options.streamEventChars);
  const includeUsage = options.includeUsage ?? true;

  const scrub = (s: string) => (options.apiKey ? s.split(options.apiKey).join('***') : s);

  async function post(req: ChatRequest, ctx: CallContext, stream: boolean): Promise<Response> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: stream ? 'text/event-stream' : 'application/json',
        ...options.headers,
        ...traceHeaders(ctx.telemetry, ctx.trace),
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify(requestBody(req, options.model, stream, includeUsage)),
      signal: anySignal(timeoutSignal(timeoutMs), ctx.signal),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(scrub(`HTTP ${res.status} from ${url}: ${body.slice(0, errorBodyChars)}`));
    }
    return res;
  }

  return {
    name,
    async chat(req, ctx): Promise<ChatResponse> {
      const res = await post(req, ctx, false);
      return toResponse(await res.json() as Record<string, unknown>);
    },
    async *stream(req, ctx): AsyncGenerator<ChatChunk> {
      const res = await post(req, ctx, true);
      if (!res.body) throw new Error(`empty stream from ${url}`);
      for await (const data of sseData(res.body)) {
        let raw: Record<string, any>;
        try {
          raw = JSON.parse(data);
        } catch {
          throw new Error(scrub(`invalid stream event from ${url}: ${data.slice(0, streamEventChars)}`));
        }
        if (raw.error) throw new Error(scrub(`stream error from ${url}: ${typeof raw.error === 'string' ? raw.error : raw.error.message ?? 'unknown'}`));
        yield toChunk(raw);
      }
    },
    native: () => ({ baseUrl: base, model: options.model }),
  };
}

/** Descriptor: what the registry and the CLI see. */
export const adapter = defineAdapter<'ModelPort', OpenAICompatibleOptions>({
  layer: 'llm',
  port: 'ModelPort',
  name: 'openai-compatible',
  direction: 'outbound',
  maps: { standard: 'OpenAI Chat Completions' },
  portVersion: PORT_VERSIONS.ModelPort,
  tiers: ['prototype', 'production'],
  description: 'Chat and streaming against any OpenAI Chat Completions compatible endpoint.',
  optionsSchema: {
    type: 'object',
    properties: {
      baseUrl: { type: 'string', minLength: 1 },
      apiKey: { type: 'string' },
      model: { type: 'string' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      includeUsage: { type: 'boolean' },
      ...limitProperties(LIMITS, {
        timeoutMs: 'Whole-request time limit, streams included',
        errorBodyChars: 'Characters of an error body kept in the error message',
        streamEventChars: 'Characters of an invalid stream event kept in the error message',
      }),
    },
    required: ['baseUrl'],
    additionalProperties: false,
  },
  limits: LIMITS,
  create: (options, ctx) => createOpenAICompatibleModel(options, ctx.name),
});

/** Inbound: the stack served as an OpenAI Chat Completions API (model aliases and `agent:<name>`), mounted by the gateway. */
export const channelAdapter = defineAdapter<'ChannelPort', OpenAICompatibleChannelOptions>({
  layer: 'interface',
  port: 'ChannelPort',
  name: 'openai-compatible',
  direction: 'inbound',
  maps: { standard: 'OpenAI Chat Completions' },
  portVersion: PORT_VERSIONS.ChannelPort,
  tiers: ['prototype', 'production'],
  description: 'Serves /v1/chat/completions and /v1/models: model aliases through the governed model, agent:<name> through the runtime.',
  optionsSchema: {
    type: 'object',
    properties: {
      basePath: { type: 'string', pattern: '^/' },
      models: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } },
      agents: { anyOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string', minLength: 1 } }] },
      ownedBy: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
  create: (options, ctx) => createOpenAICompatibleChannel(options, ctx.name),
});

export const adapters = [adapter, channelAdapter];
