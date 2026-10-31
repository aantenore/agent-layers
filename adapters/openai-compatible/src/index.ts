import {
  activeTrace, anySignal, defineAdapter, defineLimits, limitProperties, limitValue, PORT_VERSIONS, timeoutSignal, type CallContext, type LimitValue, type ModelDelta,
  type ModelPort, type ModelReply, type ModelRequest,
} from '@agent-layers/core';
import { createOpenAICompatibleChannel, type OpenAICompatibleChannelOptions } from './inbound.ts';
import { sseData } from './sse.ts';
import { DeltaReader, EXT_KEYS, replyIn, requestOut } from './wire.ts';

export { createOpenAICompatibleChannel, parseChatBody, type OpenAICompatibleChannelOptions } from './inbound.ts';
export { SseLimitError, sseData } from './sse.ts';

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
  /** Longest stream event, or line waiting for its end, accepted from the backend (default 1048576 characters). */
  maxEventChars?: LimitValue;
  /** Field that carries `settings.maxOutputTokens` (default `max_tokens`; newer OpenAI models want `max_completion_tokens`). */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Send the reasoning parts of earlier assistant messages back, for backends that accept them (default false). */
  sendReasoning?: boolean;
}

/** Configurable limits of the model descriptor; see docs/limits.md. */
export const LIMITS = defineLimits({
  timeoutMs: { path: 'options.timeoutMs', default: 120_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 600_000 } },
  errorBodyChars: { path: 'options.errorBodyChars', default: 300, unit: 'chars', min: 0, max: 100_000, safe: { max: 2000 } },
  streamEventChars: { path: 'options.streamEventChars', default: 100, unit: 'chars', min: 0, max: 100_000, safe: { max: 2000 } },
  maxEventChars: { path: 'options.maxEventChars', default: 1_048_576, unit: 'chars', min: 1, unbounded: 'fail', safe: { max: 16_777_216 } },
});

/** What the package declares about `ext`: every key is in the `openai` namespace (both descriptors share it). */
const EXT_DECLARATION = { namespace: 'openai', produces: EXT_KEYS };

/** Factory: usable directly from code, without the registry. */
export function createOpenAICompatibleModel(options: OpenAICompatibleOptions, name = 'openai-compatible'): ModelPort {
  const base = options.baseUrl.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const timeoutMs = limitValue(LIMITS.timeoutMs, options.timeoutMs);
  const errorBodyChars = limitValue(LIMITS.errorBodyChars, options.errorBodyChars);
  const streamEventChars = limitValue(LIMITS.streamEventChars, options.streamEventChars);
  const maxEventChars = limitValue(LIMITS.maxEventChars, options.maxEventChars);
  const includeUsage = options.includeUsage ?? true;

  const scrub = (s: string) => (options.apiKey ? s.split(options.apiKey).join('***') : s);

  async function post(req: ModelRequest, ctx: CallContext, stream: boolean): Promise<Response> {
    const trace = activeTrace(ctx.telemetry, ctx.trace);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: stream ? 'text/event-stream' : 'application/json',
        ...options.headers,
        ...(trace?.parent ? { traceparent: trace.parent, ...(trace.state ? { tracestate: trace.state } : {}) } : {}),
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify(requestOut(req, {
        ...(options.model !== undefined ? { defaultModel: options.model } : {}), stream, includeUsage,
        ...(options.maxTokensField ? { maxTokensField: options.maxTokensField } : {}), sendReasoning: options.sendReasoning === true,
      })),
      signal: anySignal(timeoutSignal(timeoutMs), ctx.signal),
      // The body carries the prompt and the headers the API key: a redirect is refused, never followed.
      redirect: 'manual',
    });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status} from ${url}: redirects are not followed`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(scrub(`HTTP ${res.status} from ${url}: ${body.slice(0, errorBodyChars)}`));
    }
    return res;
  }

  /** The model the backend is asked for, reported when its answer names none. */
  const sentModel = (req: ModelRequest) => (req.model === '' || req.model === 'default' ? (options.model ?? req.model) : req.model);

  return {
    name,
    async chat(req, ctx): Promise<ModelReply> {
      const res = await post(req, ctx, false);
      const raw: unknown = await res.json().catch(() => undefined);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid response from ${url}: not a JSON object`);
      return replyIn(raw as Record<string, unknown>, sentModel(req));
    },
    async *stream(req, ctx): AsyncGenerator<ModelDelta> {
      const res = await post(req, ctx, true);
      if (!res.body) throw new Error(`empty stream from ${url}`);
      const reader = new DeltaReader();
      for await (const data of sseData(res.body, maxEventChars)) {
        let raw: Record<string, any>;
        try {
          raw = JSON.parse(data);
        } catch {
          throw new Error(scrub(`invalid stream event from ${url}: ${data.slice(0, streamEventChars)}`));
        }
        if (!raw || typeof raw !== 'object') continue;
        if (raw.error) throw new Error(scrub(`stream error from ${url}: ${typeof raw.error === 'string' ? raw.error : raw.error.message ?? 'unknown'}`));
        yield* reader.push(raw);
      }
      yield reader.end(sentModel(req));
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
      maxTokensField: { enum: ['max_tokens', 'max_completion_tokens'] },
      sendReasoning: { type: 'boolean' },
      ...limitProperties(LIMITS, {
        timeoutMs: 'Whole-request time limit, streams included',
        errorBodyChars: 'Characters of an error body kept in the error message',
        streamEventChars: 'Characters of an invalid stream event kept in the error message',
        maxEventChars: 'Longest stream event, or line waiting for its end, accepted from the backend',
      }),
    },
    required: ['baseUrl'],
    additionalProperties: false,
  },
  limits: LIMITS,
  ext: EXT_DECLARATION,
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
      reasoning: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  ext: EXT_DECLARATION,
  // Role aliases and finish values added to the vocabularies are resolved at the edge, after composition.
  create: (options, ctx) => createOpenAICompatibleChannel(options, ctx.name, () => {
    try { return ctx.stack?.().vocabularies; } catch { return undefined; }
  }),
});

export const adapters = [adapter, channelAdapter];
