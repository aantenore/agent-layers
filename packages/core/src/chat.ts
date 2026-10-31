import type { ChatChunk, ChatMessage, ChatResponse, ContentPart, ToolCall } from './ports/model.ts';

/** Text of a message content, joining text parts. */
export function contentText(content: string | ContentPart[] | null | undefined): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content.filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
}

/** Indexes of the user messages after the last assistant message: the new user content of a turn. */
export function newUserMessageIndexes(messages: readonly ChatMessage[]): number[] {
  const out: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]!.role;
    if (role === 'assistant') break;
    if (role === 'user') out.unshift(i);
  }
  return out;
}

/** Text of the last user message, or ''. */
export function lastUserText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') return contentText(messages[i]!.content);
  return '';
}

/** Assistant text of the first choice. */
export function responseText(res: ChatResponse): string {
  return res.choices[0]?.message.content ?? '';
}

/** Rebuilds a full response from streamed chunks. */
export function assembleChunks(chunks: Iterable<ChatChunk>, model = ''): ChatResponse {
  let id: string | undefined;
  let content = '';
  let finish: string | null = null;
  let usage: ChatResponse['usage'];
  const calls: ToolCall[] = [];
  for (const chunk of chunks) {
    id ??= chunk.id;
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;
    if (choice.delta.content) content += choice.delta.content;
    if (choice.finish_reason) finish = choice.finish_reason;
    for (const d of choice.delta.tool_calls ?? []) {
      const call = (calls[d.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (d.id) call.id = d.id;
      if (d.function?.name) call.function.name += d.function.name;
      if (d.function?.arguments) call.function.arguments += d.function.arguments;
    }
  }
  const toolCalls = calls.filter(Boolean);
  return {
    ...(id ? { id } : {}),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: content || (toolCalls.length ? null : ''), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: finish,
    }],
    ...(usage ? { usage } : {}),
  };
}

/** Splits a full response into the chunks a stream would have produced. */
export function* responseToChunks(res: ChatResponse): Generator<ChatChunk> {
  const choice = res.choices[0];
  const base = { ...(res.id ? { id: res.id } : {}), model: res.model };
  if (choice?.message.content) yield { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: choice.message.content } }] };
  const calls = choice?.message.tool_calls ?? [];
  if (calls.length) {
    yield { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls.map((c, index) => ({ index, id: c.id, type: 'function', function: { ...c.function } })) } }] };
  }
  yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason ?? 'stop' }], ...(res.usage ? { usage: res.usage } : {}) };
}
