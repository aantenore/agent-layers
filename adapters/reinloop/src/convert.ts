import { messageText, textMessage, type Finish, type Message as SdkMessage, type ModelReply, type ModelRequest as SdkRequest, type Part as SdkPart, type Usage as SdkUsage } from '@agent-layers/core';
import type { Message, ModelParams, ModelRequest, ModelResponse, Part, StopReason, ToolCallPart } from 'reinloop';

/**
 * reinloop request → SDK model request: instructions become the system message, parts map one to one. Sampling
 * settings that have a slot in the language go to `settings`; `ext` is the agent's, for the model adapter.
 */
export function toModelRequest(req: ModelRequest, ext?: SdkRequest['ext']): SdkRequest {
  const settings = settingsOf(req.params);
  return {
    model: req.model,
    messages: toMessages(req.instructions, req.messages),
    ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, params: t.schema })) } : {}),
    ...(Object.keys(settings).length ? { settings } : {}),
    ...(ext && Object.keys(ext).length ? { ext } : {}),
  };
}

function settingsOf(p: ModelParams | undefined): NonNullable<SdkRequest['settings']> {
  if (!p) return {};
  return {
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.maxTokens !== undefined ? { maxOutputTokens: p.maxTokens } : {}),
    ...(p.stop ? { stop: p.stop } : {}),
  };
}

export function toMessages(instructions: string | undefined, messages: readonly Message[]): SdkMessage[] {
  const out: SdkMessage[] = instructions ? [textMessage('system', instructions)] : [];
  for (const m of messages) out.push({ role: m.role, parts: m.parts.flatMap((p) => toPart(p) ?? []) });
  return out;
}

/** reinloop part → SDK part. Hosted-tool parts have no equivalent in the language and are left out. */
function toPart(p: Part): SdkPart | undefined {
  switch (p.type) {
    case 'text': return { type: 'text', text: p.text };
    case 'thinking': return { type: 'reasoning', text: p.text };
    case 'tool_call': return { type: 'call', id: p.id, tool: p.name, args: objectOf(p.args) };
    case 'tool_result': return { type: 'result', callId: p.callId, ok: !p.isError, text: p.content };
    default: return undefined;
  }
}

/** SDK reply → reinloop response. Malformed tool arguments are flagged, so the loop answers them with a tool error. */
export function fromModelReply(reply: ModelReply, model: string): ModelResponse {
  const parts = reply.message.parts.flatMap((p) => fromPart(p, new Map()) ?? []);
  return {
    message: { role: 'assistant', parts },
    usage: fromUsage(reply.usage),
    stopReason: parts.some(isCall) ? 'tool_calls' : stopOf(reply.finish),
    model: reply.model || model,
  };
}

/** SDK input messages → reinloop messages; system messages join the instructions. */
export function fromMessages(messages: readonly SdkMessage[]): { system: string[]; messages: Message[] } {
  const system: string[] = [];
  const out: Message[] = [];
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'system') system.push(messageText(m));
    else out.push({ role: m.role, parts: m.parts.flatMap((p) => fromPart(p, names) ?? []) });
  }
  return { system, messages: out };
}

/** SDK part → reinloop part; `names` maps call ids to tool names, which reinloop keeps on results. */
function fromPart(p: SdkPart, names: Map<string, string>): Part | undefined {
  switch (p.type) {
    case 'text': return { type: 'text', text: (p as { text: string }).text };
    case 'reasoning': return { type: 'thinking', text: (p as { text: string }).text };
    case 'call': {
      const c = p as Extract<SdkPart, { type: 'call' }>;
      names.set(c.id, c.tool);
      const call: ToolCallPart = { type: 'tool_call', id: c.id, name: c.tool, args: c.args };
      return c.invalid !== undefined ? { ...call, args: {}, argsIssue: { error: 'arguments must be a JSON object', repaired: false } } : call;
    }
    case 'result': {
      const r = p as Extract<SdkPart, { type: 'result' }>;
      return { type: 'tool_result', callId: r.callId, name: names.get(r.callId) ?? '', content: r.text, ...(r.ok ? {} : { isError: true }) };
    }
    default: return undefined;
  }
}

export const fromUsage = (u: SdkUsage | undefined) => ({ inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0 });

const STOP: Record<string, StopReason> = { end: 'end', tools: 'tool_calls', limit: 'max_tokens', refused: 'refusal' };
const FINISH: Record<StopReason, Finish> = { end: 'end', tool_calls: 'tools', max_tokens: 'limit', refusal: 'refused', pause_turn: 'other', other: 'other' };

export const stopOf = (finish: Finish): StopReason => STOP[finish] ?? 'other';
export const finishOf = (stop: StopReason): Finish => FINISH[stop] ?? 'other';

const isCall = (p: Part): p is ToolCallPart => p.type === 'tool_call';
const objectOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

