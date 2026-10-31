import type { ChatChunk, ChatRequest, ChatResponse, ToolCall, ToolCallDelta, Usage } from '@agent-layers/core';

type Json = Record<string, any>;

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** Arguments travel as a JSON string; some backends send an object. */
const args = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

/** Request body: defined fields only, `extra` merged in, `stream` set last. */
export function requestBody(req: ChatRequest, model: string | undefined, stream: boolean, includeUsage: boolean): Json {
  const body: Json = {
    model: req.model === '' || req.model === 'default' ? (model ?? req.model) : req.model,
    messages: req.messages,
    tools: req.tools,
    tool_choice: req.tool_choice,
    temperature: req.temperature,
    max_tokens: req.max_tokens,
    stop: req.stop,
    ...req.extra,
    stream,
    ...(stream && includeUsage ? { stream_options: { include_usage: true } } : {}),
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

function usageOf(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Json;
  const total = num(u.total_tokens);
  return { prompt_tokens: num(u.prompt_tokens) ?? 0, completion_tokens: num(u.completion_tokens) ?? 0, ...(total !== undefined ? { total_tokens: total } : {}) };
}

function toolCallOf(raw: Json, i: number): ToolCall {
  return { id: text(raw.id) ?? `call_${i}`, type: 'function', function: { name: text(raw.function?.name) ?? '', arguments: args(raw.function?.arguments) } };
}

/** Maps a non-streamed response body to a ChatResponse. */
export function toResponse(raw: Json): ChatResponse {
  const { id, model, choices, usage, ...rest } = raw;
  const mapped = (Array.isArray(choices) ? choices : []).map((c: Json, i: number) => {
    const m: Json = c?.message ?? {};
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls.map(toolCallOf) : [];
    const content = typeof m.content === 'string' ? m.content : calls.length ? null : '';
    return {
      index: num(c?.index) ?? i,
      message: { role: 'assistant' as const, content, ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: text(c?.finish_reason) ?? null,
    };
  });
  const u = usageOf(usage);
  return {
    ...(text(id) ? { id: text(id)! } : {}),
    model: text(model) ?? '',
    choices: mapped,
    ...(u ? { usage: u } : {}),
    ...(Object.keys(rest).length ? { extra: rest } : {}),
  };
}

/** Maps one streamed event payload to a ChatChunk. */
export function toChunk(raw: Json): ChatChunk {
  const choices = (Array.isArray(raw.choices) ? raw.choices : []).map((c: Json, i: number) => {
    const d: Json = c?.delta ?? {};
    const delta: ChatChunk['choices'][number]['delta'] = {};
    if (d.role === 'assistant') delta.role = 'assistant';
    if (typeof d.content === 'string' || d.content === null) delta.content = d.content;
    if (Array.isArray(d.tool_calls)) {
      delta.tool_calls = d.tool_calls.map((t: Json, j: number): ToolCallDelta => {
        const fn = t?.function;
        return {
          index: num(t?.index) ?? j,
          ...(text(t?.id) ? { id: text(t.id)! } : {}),
          ...(t?.type === 'function' || fn ? { type: 'function' as const } : {}),
          ...(fn ? { function: { ...(text(fn.name) !== undefined ? { name: fn.name } : {}), ...(fn.arguments !== undefined ? { arguments: args(fn.arguments) } : {}) } } : {}),
        };
      });
    }
    return { index: num(c?.index) ?? i, delta, ...(c?.finish_reason !== undefined ? { finish_reason: c.finish_reason } : {}) };
  });
  const u = usageOf(raw.usage);
  return { ...(text(raw.id) ? { id: raw.id } : {}), ...(text(raw.model) ? { model: raw.model } : {}), choices, ...(u ? { usage: u } : {}) };
}
