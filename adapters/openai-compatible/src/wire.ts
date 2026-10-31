// Translation between the OpenAI Chat Completions wire and the SDK language, both ways. The outbound model adapter
// and the inbound channel use the same tables, so a request or reply crossing the stack keeps its shape.
import {
  callsOf, parseArgs, type CallPart, type Ext, type Finish, type MediaPart, type Message, type ModelDelta, type ModelReply, type ModelRequest, type ModelSettings,
  type Part, type ReasoningPart, type ResultPart, type Role, type TextPart, type ToolInfo, type ToolMode, type Usage,
} from '@agent-layers/core';

type Json = Record<string, any>;

/** Ext keys this package writes, all in the `openai` namespace. */
export const EXT = {
  /** Wire role of a message when it is not the language role (`developer`, or a configured alias). */
  role: 'openai.role',
  /** Message fields the language has no place for (`name`, `refusal`, `audio`, `annotations`, ...). */
  fields: 'openai.fields',
  /** Usage details beyond the input and output tokens (`total_tokens`, `*_tokens_details`). */
  usage: 'openai.usage',
  /** The choices after the first, as the wire has them (`n > 1`). */
  choices: 'openai.choices',
  /** The native `finish_reason` when the language finish does not map back to it. */
  finish: 'openai.finish_reason',
  /** Top-level reply fields other than id, model, choices and usage (`object`, `created`, `system_fingerprint`). */
  response: 'openai.response',
  /** `logprobs` of the first choice. */
  logprobs: 'openai.choice_logprobs',
  /** `reasoning` when the backend used that field instead of `reasoning_content`. */
  reasoningField: 'openai.reasoning_field',
  /** `detail` of an `image_url` part. */
  detail: 'openai.detail',
  /** `max_completion_tokens` when the request used it instead of `max_tokens`. */
  maxField: 'openai.max_tokens_field',
} as const;

/** Request fields carried as `ext["openai.<field>"]`, passed through untouched. */
export const PASSTHROUGH = [
  'response_format', 'seed', 'top_p', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'user', 'parallel_tool_calls', 'reasoning_effort', 'n',
  'logprobs', 'top_logprobs',
] as const;

/**
 * Passthrough fields a caller of the inbound channel may not set: they ask the backend for content the output guards
 * never read (extra choices, log probabilities). `n` other than 1 is refused; the others are dropped.
 */
export const INBOUND_REFUSED = ['n', 'logprobs', 'top_logprobs'] as const;

/** Every ext key the package may write. */
export const EXT_KEYS: readonly string[] = [...Object.values(EXT), ...PASSTHROUGH.map((k) => `openai.${k}`)];

/** Type of the adapter part that carries a wire content part the language has no part for. */
export const RAW_PART = 'openai.part';

const LANGUAGE_ROLES: readonly string[] = ['system', 'user', 'assistant', 'tool'];
const MESSAGE_KEYS = new Set(['role', 'content', 'tool_calls', 'tool_call_id', 'reasoning_content', 'reasoning']);
const FINISH_IN: Record<string, Finish> = { stop: 'end', length: 'limit', tool_calls: 'tools', function_call: 'tools', content_filter: 'refused' };
const FINISH_OUT: Record<string, string> = { end: 'stop', limit: 'length', tools: 'tool_calls', refused: 'content_filter' };
const AUDIO = /^audio\/(.+)$/;
const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/** A wire document the translation cannot read; the inbound channel answers 400 with the message. */
export class WireError extends Error { override name = 'WireError'; }

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** Arguments travel as a JSON string; some backends send an object. */
const argsText = (v: unknown): string | undefined => (typeof v === 'string' ? v : v === undefined || v === null ? undefined : JSON.stringify(v));
/** The bag without undefined values; undefined when nothing is left. */
const bag = (values: Json): Ext | undefined => {
  for (const k of Object.keys(values)) if (values[k] === undefined) delete values[k];
  return Object.keys(values).length ? values : undefined;
};

// ---- finish and usage ---------------------------------------------------------------------------------------

/** Language finish of a native `finish_reason`: `tools` exactly when there are calls; unknown values are `other`. */
export function finishIn(native: unknown, hasCalls: boolean): { finish: Finish; ext?: Ext } {
  const mapped = typeof native === 'string' ? FINISH_IN[native] : undefined;
  const finish: Finish = hasCalls ? 'tools' : mapped && mapped !== 'tools' ? mapped : 'other';
  // The native value is kept when the finish would not map back to it, so the round trip is exact.
  return native !== undefined && native !== FINISH_OUT[finish] ? { finish, ext: { [EXT.finish]: native } } : { finish };
}

/** Native `finish_reason` of a language finish. `core` resolves a configured value to the core value it is like. */
export function finishOut(finish: Finish, ext: Ext | undefined, core: (f: string) => string | undefined = () => undefined): string | null {
  if (ext && Object.hasOwn(ext, EXT.finish)) return ext[EXT.finish] as string | null;
  return FINISH_OUT[finish] ?? FINISH_OUT[core(finish) ?? ''] ?? 'stop';
}

export function usageIn(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined;
  const { prompt_tokens, completion_tokens, ...rest } = raw;
  const details = bag({ ...rest });
  return { inputTokens: num(prompt_tokens) ?? 0, outputTokens: num(completion_tokens) ?? 0, ...(details ? { ext: { [EXT.usage]: details } } : {}) };
}

export function usageOut(u: Usage | undefined): Json | undefined {
  if (!u) return undefined;
  const details = isRecord(u.ext?.[EXT.usage]) ? u.ext![EXT.usage] as Json : {};
  return { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens, total_tokens: u.inputTokens + u.outputTokens, ...details };
}

// ---- messages -----------------------------------------------------------------------------------------------

function mediaIn(item: Json): MediaPart | undefined {
  if (item.type === 'image_url') {
    const url = str(isRecord(item.image_url) ? item.image_url.url : item.image_url);
    if (!url) return undefined;
    const detail = isRecord(item.image_url) ? str(item.image_url.detail) : undefined;
    const ext = detail ? { ext: { [EXT.detail]: detail } } : {};
    const data = DATA_URL.exec(url);
    return data ? { type: 'media', mediaType: data[1]!, data: data[2]!, ...ext } : { type: 'media', mediaType: 'image/*', url, ...ext };
  }
  if (item.type === 'input_audio' && isRecord(item.input_audio) && typeof item.input_audio.data === 'string') {
    return { type: 'media', mediaType: `audio/${str(item.input_audio.format) ?? 'wav'}`, data: item.input_audio.data };
  }
  return undefined;
}

function mediaOut(p: MediaPart): Json {
  const audio = AUDIO.exec(p.mediaType);
  if (audio && p.data !== undefined) return { type: 'input_audio', input_audio: { data: p.data, format: audio[1] } };
  const url = p.data !== undefined ? `data:${p.mediaType};base64,${p.data}` : p.url ?? '';
  const detail = str(p.ext?.[EXT.detail]);
  return { type: 'image_url', image_url: { url, ...(detail ? { detail } : {}) } };
}

/**
 * Parts of a wire `content`: a string is one text part (an empty string too, so an answer that is only reasoning
 * still says it has no text); text, image and audio items map; others are kept raw. `null` is no part.
 */
function contentIn(content: unknown): Part[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): Part[] => {
    if (!isRecord(item)) return [];
    if (item.type === 'text' && typeof item.text === 'string') return [{ type: 'text', text: item.text }];
    return [mediaIn(item) ?? { type: RAW_PART, part: item }];
  });
}

/** Wire `content` of parts: one plain string when the parts are text only (at most one), else a list of items. */
function contentOut(parts: readonly Part[]): string | Json[] {
  const kept = parts.filter((p) => p.type === 'text' || p.type === 'media' || p.type === RAW_PART);
  if (kept.every((p) => p.type === 'text') && kept.length <= 1) return (kept[0] as TextPart | undefined)?.text ?? '';
  return kept.map((p) => (p.type === 'text' ? { type: 'text', text: (p as TextPart).text } : p.type === 'media' ? mediaOut(p as MediaPart) : (p as unknown as { part: Json }).part));
}

/** Text of a wire `content` (tool results): a string, or the text items joined. */
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => isRecord(c) && typeof c.text === 'string').map((c) => c.text).join('\n') : '';

/** `developer` is a system message; other roles are taken as they are. */
export const defaultRole = (role: string): string => (role === 'developer' ? 'system' : role);

/**
 * One wire message as a language message. `resolveRole` maps a wire role to a language role (`developer` → `system`,
 * configured aliases); the wire role is kept in `ext["openai.role"]` when it differs. Throws WireError on an unknown role.
 */
export function messageIn(m: unknown, resolveRole: (role: string) => string = defaultRole): Message {
  if (!isRecord(m) || typeof m.role !== 'string') throw new WireError('a message needs a role');
  const role = resolveRole(m.role);
  if (!LANGUAGE_ROLES.includes(role)) throw new WireError(`unknown role "${m.role}"`);
  const fields = bag(Object.fromEntries(Object.entries(m).filter(([k]) => !MESSAGE_KEYS.has(k))));
  const ext = bag({ [EXT.role]: role !== m.role ? m.role : undefined, [EXT.fields]: fields });
  const parts: Part[] = [];
  if (role === 'tool') {
    parts.push({ type: 'result', callId: str(m.tool_call_id) ?? '', ok: true, text: textOf(m.content) });
  } else if (role === 'assistant') {
    const reasoning = str(m.reasoning_content) ?? str(m.reasoning);
    if (reasoning) {
      const field = m.reasoning_content === undefined ? { ext: { [EXT.reasoningField]: 'reasoning' } } : {};
      parts.push({ type: 'reasoning', text: reasoning, ...field });
    }
    parts.push(...contentIn(m.content));
    for (const [i, t] of (Array.isArray(m.tool_calls) ? m.tool_calls : []).entries()) {
      if (!isRecord(t)) continue;
      const { args, invalid } = parseArgs(argsText(t.function?.arguments));
      parts.push({ type: 'call', id: str(t.id) ?? `call_${i}`, tool: str(t.function?.name) ?? '', args, ...(invalid !== undefined ? { invalid } : {}) });
    }
  } else {
    parts.push(...contentIn(m.content));
  }
  return { role: role as Role, parts, ...(ext ? { ext } : {}) };
}

const callOut = (c: CallPart): Json => ({ id: c.id, type: 'function', function: { name: c.tool, arguments: c.invalid ?? JSON.stringify(c.args ?? {}) } });

export interface MessageOutOptions {
  /** Send reasoning parts (default false). */
  reasoning?: boolean;
  /** Restore the wire role and the extra message fields kept in ext (default true). */
  restore?: boolean;
}

/**
 * One language message as wire messages: a `tool` message gives one wire message per result part (`ok` has no wire
 * field). Reasoning parts are sent only with `reasoning: true`, under `reasoning_content` (or `reasoning` when the part
 * came from that field).
 */
export function messageOut(m: Message, opts: MessageOutOptions = {}): Json[] {
  const restore = opts.restore !== false;
  const role = (restore ? str(m.ext?.[EXT.role]) : undefined) ?? m.role;
  const fields = restore && isRecord(m.ext?.[EXT.fields]) ? m.ext![EXT.fields] as Json : {};
  if (m.role === 'tool') {
    return m.parts.filter((p): p is ResultPart => p.type === 'result').map((p) => ({ ...fields, role, tool_call_id: p.callId, content: p.text }));
  }
  if (m.role !== 'assistant') return [{ ...fields, role, content: contentOut(m.parts) }];
  const calls = callsOf(m);
  const content = contentOut(m.parts);
  const hasText = m.parts.some((p) => p.type === 'text');
  const reasoning = opts.reasoning ? m.parts.filter((p): p is ReasoningPart => p.type === 'reasoning') : [];
  const reasoningField = reasoning.length ? (str(reasoning[0]!.ext?.[EXT.reasoningField]) ?? 'reasoning_content') : undefined;
  return [{
    ...fields,
    role,
    content: !hasText && calls.length ? null : content,
    ...(reasoningField ? { [reasoningField]: reasoning.map((p) => p.text).join('') } : {}),
    ...(calls.length ? { tool_calls: calls.map(callOut) } : {}),
  }];
}

// ---- tools --------------------------------------------------------------------------------------------------

export function toolsIn(raw: unknown): ToolInfo[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((t): ToolInfo[] => {
    const fn = isRecord(t) && (t.type === 'function' || t.type === undefined) && isRecord(t.function) ? t.function : undefined;
    if (!fn || typeof fn.name !== 'string') return [];
    return [{ name: fn.name, ...(typeof fn.description === 'string' ? { description: fn.description } : {}), params: isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} } }];
  });
}

export const toolsOut = (tools: readonly ToolInfo[]): Json[] =>
  tools.map((t) => ({ type: 'function', function: { name: t.name, ...(t.description !== undefined ? { description: t.description } : {}), parameters: t.params } }));

export function toolModeIn(raw: unknown): ToolMode | undefined {
  if (raw === 'auto' || raw === 'none' || raw === 'required') return raw;
  if (isRecord(raw) && isRecord(raw.function) && typeof raw.function.name === 'string') return { tool: raw.function.name };
  return undefined;
}

export const toolModeOut = (mode: ToolMode): string | Json => (typeof mode === 'string' ? mode : { type: 'function', function: { name: mode.tool } });

// ---- requests -----------------------------------------------------------------------------------------------

/** A wire request body as a language request. Throws WireError when a message cannot be read. */
export function requestIn(b: Json, resolveRole: (role: string) => string = defaultRole): ModelRequest {
  const messages = (Array.isArray(b.messages) ? b.messages : []).map((m: unknown, i: number) => {
    try { return messageIn(m, resolveRole); } catch (err) { throw new WireError(`messages[${i}]: ${(err as Error).message}`); }
  });
  const tools = toolsIn(b.tools);
  const toolMode = toolModeIn(b.tool_choice);
  const maxOutputTokens = num(b.max_completion_tokens) ?? num(b.max_tokens);
  const stop = typeof b.stop === 'string' ? [b.stop] : Array.isArray(b.stop) ? b.stop.filter((s: unknown): s is string => typeof s === 'string') : undefined;
  const settings: ModelSettings = {
    ...(num(b.temperature) !== undefined ? { temperature: b.temperature } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(stop?.length ? { stop } : {}),
  };
  const ext = bag({
    ...Object.fromEntries(PASSTHROUGH.filter((k) => b[k] !== undefined).map((k) => [`openai.${k}`, b[k]])),
    [EXT.maxField]: num(b.max_completion_tokens) !== undefined ? 'max_completion_tokens' : undefined,
  });
  return {
    model: str(b.model) ?? '',
    messages,
    ...(tools ? { tools } : {}),
    ...(toolMode ? { toolMode } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
    ...(ext ? { ext } : {}),
  };
}

export interface RequestOutOptions {
  /** Model sent when the request model is `""` or `"default"`. */
  defaultModel?: string;
  /** Sets `stream` (and `stream_options.include_usage` with `includeUsage`); omitted when undefined. */
  stream?: boolean;
  includeUsage?: boolean;
  /** Field that carries `maxOutputTokens` (default `max_tokens`, unless the request names the other one in ext). */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Send reasoning parts of assistant messages back to the backend (default false). */
  sendReasoning?: boolean;
}

/** A language request as a wire request body. */
export function requestOut(req: ModelRequest, opts: RequestOutOptions = {}): Json {
  const s = req.settings ?? {};
  const maxField = str(req.ext?.[EXT.maxField]) ?? opts.maxTokensField ?? 'max_tokens';
  const body: Json = {
    model: req.model === '' || req.model === 'default' ? (opts.defaultModel ?? req.model) : req.model,
    messages: req.messages.flatMap((m) => messageOut(m, { reasoning: opts.sendReasoning === true })),
    ...(req.tools?.length ? { tools: toolsOut(req.tools) } : {}),
    ...(req.toolMode !== undefined ? { tool_choice: toolModeOut(req.toolMode) } : {}),
    ...(s.temperature !== undefined ? { temperature: s.temperature } : {}),
    ...(s.maxOutputTokens !== undefined ? { [maxField]: s.maxOutputTokens } : {}),
    ...(s.stop?.length ? { stop: s.stop } : {}),
  };
  for (const k of PASSTHROUGH) if (req.ext?.[`openai.${k}`] !== undefined) body[k] = req.ext[`openai.${k}`];
  if (opts.stream !== undefined) {
    body.stream = opts.stream;
    if (opts.stream && opts.includeUsage) body.stream_options = { include_usage: true };
  }
  return body;
}

// ---- replies ------------------------------------------------------------------------------------------------

/** A non-streamed wire reply as a language reply: the first choice; the others in `ext["openai.choices"]`. */
export function replyIn(raw: Json, fallbackModel = ''): ModelReply {
  const { id, model, choices, usage, ...rest } = raw;
  const list: unknown[] = Array.isArray(choices) ? choices : [];
  const first: Json = isRecord(list[0]) ? list[0] : {};
  const message = messageIn({ ...(isRecord(first.message) ? first.message : {}), role: 'assistant' });
  const { finish, ext: finishExt } = finishIn(first.finish_reason, callsOf(message).length > 0);
  const u = usageIn(usage);
  const ext = bag({
    ...finishExt,
    [EXT.response]: bag({ ...rest }),
    [EXT.choices]: list.length > 1 ? list.slice(1) : undefined,
    [EXT.logprobs]: first.logprobs,
  });
  return {
    model: str(model) ?? fallbackModel,
    message,
    finish,
    ...(u ? { usage: u } : {}),
    ...(str(id) ? { id: str(id)! } : {}),
    ...(ext ? { ext } : {}),
  };
}

export interface Envelope { id?: string; object?: string; created?: number; model?: string }

/** A language reply as a wire reply. `envelope` replaces the top-level fields; `core` resolves configured finishes. */
export function replyOut(reply: ModelReply, envelope: Envelope = {}, core?: (f: string) => string | undefined): Json {
  const ext = reply.ext ?? {};
  const response = isRecord(ext[EXT.response]) ? ext[EXT.response] as Json : {};
  const first: Json = {
    index: 0,
    message: messageOut(reply.message, { reasoning: true })[0],
    finish_reason: finishOut(reply.finish, reply.ext, core),
    ...(Object.hasOwn(ext, EXT.logprobs) ? { logprobs: ext[EXT.logprobs] } : {}),
  };
  const others = Array.isArray(ext[EXT.choices]) ? ext[EXT.choices] as Json[] : [];
  const usage = usageOut(reply.usage);
  return {
    ...response,
    ...(reply.id ? { id: reply.id } : {}),
    model: reply.model,
    ...bag({ ...envelope }),
    choices: [first, ...others],
    ...(usage ? { usage } : {}),
  };
}

/**
 * A language reply as the inbound channel answers it: one choice built from the guarded message only. Nothing kept in
 * ext is re-emitted (other choices, log probabilities, extra message or response fields), since output guards never
 * read it; reasoning only with `reasoning: true`.
 */
export function replyToCaller(reply: ModelReply, envelope: Envelope, opts: { reasoning?: boolean; core?: (f: string) => string | undefined } = {}): Json {
  const message = { ...messageOut(reply.message, { reasoning: opts.reasoning === true, restore: false })[0], role: 'assistant' };
  const usage = usageOut(reply.usage);
  return {
    ...(reply.id ? { id: reply.id } : {}),
    model: reply.model,
    ...bag({ ...envelope }),
    choices: [{ index: 0, message, finish_reason: finishOut(reply.finish, reply.ext, opts.core), logprobs: null }],
    ...(usage ? { usage } : {}),
  };
}

// ---- streams ------------------------------------------------------------------------------------------------

/**
 * Reads wire chunks into deltas. Only the first choice is streamed. `end()` gives the one `end` delta, with the finish
 * (`tools` exactly when a call was streamed), usage, id, model and the other top-level fields in ext.
 */
export class DeltaReader {
  #native: unknown = undefined;
  #usage: Usage | undefined;
  #id: string | undefined;
  #model: string | undefined;
  #response: Json | undefined;
  #calls = false;

  push(raw: Json): ModelDelta[] {
    const { id, model, choices, usage, ...rest } = raw;
    this.#id ??= str(id);
    this.#model ??= str(model);
    this.#response ??= bag({ ...rest });
    if (isRecord(usage)) this.#usage = usageIn(usage);
    const list: unknown[] = Array.isArray(choices) ? choices : [];
    const c = list.find((x) => isRecord(x) && (x.index === 0 || x.index === undefined)) as Json | undefined;
    if (!c) return [];
    const d: Json = isRecord(c.delta) ? c.delta : {};
    const out: ModelDelta[] = [];
    const reasoning = str(d.reasoning_content) ?? str(d.reasoning);
    if (reasoning) out.push({ type: 'reasoning', text: reasoning });
    if (typeof d.content === 'string' && d.content) out.push({ type: 'text', text: d.content });
    for (const [j, t] of (Array.isArray(d.tool_calls) ? d.tool_calls : []).entries()) {
      if (!isRecord(t)) continue;
      this.#calls = true;
      const fn: Json = isRecord(t.function) ? t.function : {};
      const args = argsText(fn.arguments);
      out.push({
        type: 'call', index: num(t.index) ?? j,
        ...(str(t.id) ? { id: t.id } : {}), ...(str(fn.name) !== undefined ? { tool: fn.name } : {}), ...(args !== undefined ? { argsText: args } : {}),
      });
    }
    if (c.finish_reason !== undefined && c.finish_reason !== null) this.#native = c.finish_reason;
    return out;
  }

  end(fallbackModel?: string): Extract<ModelDelta, { type: 'end' }> {
    const { finish, ext: finishExt } = finishIn(this.#native, this.#calls);
    const ext = bag({ ...finishExt, [EXT.response]: this.#response });
    const model = this.#model ?? fallbackModel;
    return {
      type: 'end', finish,
      ...(this.#usage ? { usage: this.#usage } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(this.#id ? { id: this.#id } : {}),
      ...(ext ? { ext } : {}),
    };
  }
}

/**
 * Writes deltas as wire chunks under one envelope: the first chunk carries `role: "assistant"`; `end` gives the chunk
 * with `finish_reason` and, with `includeUsage`, a last chunk with no choices and the usage.
 */
export class ChunkWriter {
  #envelope: Json;
  #first = true;
  #includeUsage: boolean;
  #core: ((f: string) => string | undefined) | undefined;
  #reasoning: boolean;

  /** `reasoning: false` leaves reasoning deltas out (default true). */
  constructor(envelope: Envelope & Json, opts: { includeUsage?: boolean; core?: (f: string) => string | undefined; reasoning?: boolean } = {}) {
    this.#envelope = { object: 'chat.completion.chunk', ...envelope };
    this.#includeUsage = opts.includeUsage === true;
    this.#core = opts.core;
    this.#reasoning = opts.reasoning !== false;
  }

  #chunk(delta: Json, finish: string | null): Json {
    const role = this.#first ? { role: 'assistant' } : {};
    this.#first = false;
    return { ...this.#envelope, choices: [{ index: 0, delta: { ...role, ...delta }, finish_reason: finish }] };
  }

  write(d: ModelDelta): Json[] {
    switch (d.type) {
      case 'text': return [this.#chunk({ content: d.text }, null)];
      case 'reasoning': return this.#reasoning ? [this.#chunk({ reasoning_content: d.text }, null)] : [];
      case 'call': {
        const fn = { ...(d.tool !== undefined ? { name: d.tool } : {}), ...(d.argsText !== undefined ? { arguments: d.argsText } : {}) };
        return [this.#chunk({ tool_calls: [{ index: d.index, ...(d.id ? { id: d.id, type: 'function' } : {}), function: fn }] }, null)];
      }
      case 'end': {
        const out = [this.#chunk({}, finishOut(d.finish, d.ext, this.#core))];
        if (this.#includeUsage) out.push({ ...this.#envelope, choices: [], usage: usageOut(d.usage) ?? null });
        return out;
      }
      default: return [];
    }
  }
}

/** A whole stream of deltas as wire chunks, the envelope taken from the `end` delta (for tests and buffered replies). */
export function chunksOut(deltas: readonly ModelDelta[], opts: { includeUsage?: boolean } = {}): Json[] {
  const end = deltas.find((d): d is Extract<ModelDelta, { type: 'end' }> => d.type === 'end');
  const response = isRecord(end?.ext?.[EXT.response]) ? end!.ext![EXT.response] as Json : {};
  const writer = new ChunkWriter({ ...(end?.id ? { id: end.id } : {}), ...response, ...(end?.model !== undefined ? { model: end.model } : {}) }, opts);
  return deltas.flatMap((d) => writer.write(d));
}
