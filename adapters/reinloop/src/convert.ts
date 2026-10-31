import { contentText, type ChatMessage, type ChatRequest, type ChatResponse, type FinishReason, type ToolCall, type Usage as ChatUsage } from '@agent-layers/core';
import type { Message, ModelParams, ModelRequest, ModelResponse, Part, StopReason, ToolCallPart, Usage } from 'reinloop';

/** reinloop request → chat request: instructions become the system message, parts become chat messages. */
export function toChatRequest(req: ModelRequest): ChatRequest {
  return {
    model: req.model,
    messages: toChatMessages(req.instructions, req.messages),
    ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.schema } })) } : {}),
    ...chatParams(req.params),
  };
}

function chatParams(p: ModelParams | undefined): Partial<ChatRequest> {
  if (!p) return {};
  const extra = { ...(p.topP !== undefined ? { top_p: p.topP } : {}), ...p.extra };
  return {
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.maxTokens !== undefined ? { max_tokens: p.maxTokens } : {}),
    ...(p.stop ? { stop: p.stop } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

export function toChatMessages(instructions: string | undefined, messages: readonly Message[]): ChatMessage[] {
  const out: ChatMessage[] = instructions ? [{ role: 'system', content: instructions }] : [];
  for (const m of messages) {
    const text = textOf(m.parts);
    if (m.role === 'user') out.push({ role: 'user', content: text });
    else if (m.role === 'assistant') {
      const calls: ToolCall[] = m.parts.filter(isCall).map((p) => ({ id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.args ?? {}) } }));
      out.push({ role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const p of m.parts) if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.callId, content: p.content });
    }
  }
  return out;
}

/** Chat response → reinloop response. Malformed tool arguments are flagged, so the loop answers them with a tool error. */
export function fromChatResponse(res: ChatResponse, model: string): ModelResponse {
  const choice = res.choices[0];
  const parts: Part[] = [];
  const text = contentText(choice?.message.content);
  if (text) parts.push({ type: 'text', text });
  for (const call of choice?.message.tool_calls ?? []) parts.push(toolCallPart(call));
  const calls = parts.some(isCall);
  return {
    message: { role: 'assistant', parts },
    usage: fromChatUsage(res.usage),
    stopReason: calls ? 'tool_calls' : stopReasonOf(choice?.finish_reason ?? null),
    model: res.model || model,
  };
}

function toolCallPart(call: ToolCall): ToolCallPart {
  const raw = call.function.arguments ?? '';
  const base = { type: 'tool_call' as const, id: call.id, name: call.function.name };
  if (!raw.trim()) return { ...base, args: {} };
  try {
    const args: unknown = JSON.parse(raw);
    if (args && typeof args === 'object' && !Array.isArray(args)) return { ...base, args };
    return { ...base, args: {}, argsIssue: { error: 'arguments must be a JSON object', repaired: false } };
  } catch (err) {
    return { ...base, args: {}, argsIssue: { error: err instanceof Error ? err.message : String(err), repaired: false } };
  }
}

/** SDK input messages → reinloop messages; system and developer messages join the instructions. */
export function fromChatMessages(messages: readonly ChatMessage[]): { system: string[]; messages: Message[] } {
  const system: string[] = [];
  const out: Message[] = [];
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') system.push(contentText(m.content));
    else if (m.role === 'user') out.push({ role: 'user', parts: [{ type: 'text', text: contentText(m.content) }] });
    else if (m.role === 'assistant') {
      const text = contentText(m.content);
      const calls = (m.tool_calls ?? []).map(toolCallPart);
      for (const c of calls) names.set(c.id, c.name);
      out.push({ role: 'assistant', parts: [...(text ? [{ type: 'text' as const, text }] : []), ...calls] });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', parts: [{ type: 'tool_result', callId: m.tool_call_id, name: names.get(m.tool_call_id) ?? '', content: contentText(m.content) }] });
    }
  }
  return { system, messages: out };
}

export function fromChatUsage(u: ChatUsage | undefined): Usage {
  return { inputTokens: u?.prompt_tokens ?? 0, outputTokens: u?.completion_tokens ?? 0 };
}

export function toChatUsage(u: Usage): ChatUsage {
  return { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens, total_tokens: u.inputTokens + u.outputTokens };
}

const STOP: Record<string, StopReason> = { stop: 'end', tool_calls: 'tool_calls', length: 'max_tokens', content_filter: 'refusal' };
const FINISH: Record<StopReason, FinishReason> = { end: 'stop', tool_calls: 'tool_calls', max_tokens: 'length', refusal: 'content_filter', pause_turn: 'other', other: 'other' };

export const stopReasonOf = (finish: FinishReason | null): StopReason => (finish ? STOP[finish] ?? 'other' : 'end');
export const finishReasonOf = (stop: StopReason): FinishReason => FINISH[stop] ?? 'other';

const isCall = (p: Part): p is ToolCallPart => p.type === 'tool_call';
const textOf = (parts: readonly Part[]) => parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('');
