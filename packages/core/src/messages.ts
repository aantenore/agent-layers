import type { CallPart, Finish, Message, ModelDelta, ModelReply, Part, TextPart, ToolInfo, Usage } from './ports/model.ts';
import type { ToolSpec } from './ports/tool.ts';

/** Text of a list of parts: the text parts joined by newlines. Reasoning, calls and other parts are left out. */
export function partsText(parts: readonly Part[] | undefined): string {
  if (!parts) return '';
  return parts.filter((p): p is TextPart => p.type === 'text' && typeof (p as TextPart).text === 'string').map((p) => p.text).join('\n');
}

/** Text of a message. */
export const messageText = (m: Message | undefined): string => partsText(m?.parts);

/** A message with one text part. */
export const textMessage = (role: Message['role'], text: string): Message => ({ role, parts: [{ type: 'text', text }] });

/** The call parts of a message. */
export const callsOf = (m: Message | undefined): CallPart[] => (m?.parts ?? []).filter((p): p is CallPart => p.type === 'call');

/** Indexes of the user messages after the last assistant message: the new user content of a turn. */
export function newUserMessageIndexes(messages: readonly Message[]): number[] {
  const out: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]!.role;
    if (role === 'assistant') break;
    if (role === 'user') out.unshift(i);
  }
  return out;
}

/** Text of the last user message, or ''. */
export function lastUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') return messageText(messages[i]);
  return '';
}

/** Assistant text of a reply. */
export const replyText = (reply: ModelReply): string => messageText(reply.message);

/** What the model sees of tool specs. */
export function toolInfos(specs: readonly ToolSpec[]): ToolInfo[] {
  return specs.map((s) => ({ name: s.name, ...(s.description ? { description: s.description } : {}), params: s.params }));
}

/**
 * Arguments of a call from the model's JSON text. Text that does not parse to an object gives empty `args` and the
 * raw text in `invalid`, so the runtime can tell the model instead of guessing.
 */
export function parseArgs(text: string | undefined): { args: Record<string, unknown>; invalid?: string } {
  if (text === undefined || text.trim() === '') return { args: {} };
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { args: v as Record<string, unknown> };
  } catch { /* fall through */ }
  return { args: {}, invalid: text };
}

/** Rebuilds a full reply from streamed deltas. A stream without an `end` delta finishes `other`. */
export function assembleDeltas(deltas: Iterable<ModelDelta>, model = ''): ModelReply {
  let text = '';
  let reasoning = '';
  let end: Extract<ModelDelta, { type: 'end' }> | undefined;
  const calls: { id: string; tool: string; argsText: string }[] = [];
  for (const d of deltas) {
    if (d.type === 'text') text += d.text;
    else if (d.type === 'reasoning') reasoning += d.text;
    else if (d.type === 'call') {
      const c = (calls[d.index] ??= { id: '', tool: '', argsText: '' });
      if (d.id) c.id = d.id;
      if (d.tool) c.tool += d.tool;
      if (d.argsText) c.argsText += d.argsText;
    } else if (d.type === 'end') end = d;
  }
  const parts: Part[] = [];
  if (reasoning) parts.push({ type: 'reasoning', text: reasoning });
  if (text) parts.push({ type: 'text', text });
  for (const c of calls.filter(Boolean)) {
    const { args, invalid } = parseArgs(c.argsText);
    parts.push({ type: 'call', id: c.id, tool: c.tool, args, ...(invalid !== undefined ? { invalid } : {}) });
  }
  const hasCalls = parts.some((p) => p.type === 'call');
  const finish: Finish = hasCalls ? 'tools' : end?.finish === 'tools' ? 'other' : end?.finish ?? 'other';
  return {
    model: end?.model ?? model,
    message: { role: 'assistant', parts },
    finish,
    ...(end?.usage ? { usage: end.usage } : {}),
    ...(end?.id ? { id: end.id } : {}),
    ...(end?.ext ? { ext: end.ext } : {}),
  };
}

/** Splits a full reply into the deltas a stream would have produced. */
export function* replyToDeltas(reply: ModelReply): Generator<ModelDelta> {
  let index = 0;
  for (const p of reply.message.parts) {
    if (p.type === 'reasoning') yield { type: 'reasoning', text: (p as { text: string }).text };
    else if (p.type === 'text') yield { type: 'text', text: (p as TextPart).text };
    else if (p.type === 'call') {
      const c = p as CallPart;
      yield { type: 'call', index: index++, id: c.id, tool: c.tool, argsText: c.invalid ?? JSON.stringify(c.args) };
    }
  }
  yield {
    type: 'end', finish: reply.finish, model: reply.model,
    ...(reply.usage ? { usage: reply.usage } : {}), ...(reply.id ? { id: reply.id } : {}), ...(reply.ext ? { ext: reply.ext } : {}),
  };
}

/** Sum of two usages; `ext` is not summed. */
export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b && { inputTokens: b.inputTokens, outputTokens: b.outputTokens };
  if (!b) return a;
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}
