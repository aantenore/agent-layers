import { contentText, defineLimits, lastUserText, limitValue, type ChatRequest, type ChatTool } from '@agent-layers/core';

export interface MockRule {
  /** Regular expression (case-insensitive) tested on the last user message. */
  match: string;
  /** Function to call, when offered in the request. Compared with the full name or the part after the last `__`. */
  tool?: string;
  /** Arguments of the call; string values may use `{{1}}`, `{{2}}` for capture groups. */
  args?: Record<string, unknown>;
  /** Text answer; may use capture group placeholders. */
  reply?: string;
}

/** What the mock model decided to say. */
export interface Decision {
  content: string | null;
  /** Full tool name and JSON arguments of the call, when it calls a tool. */
  call?: { name: string; arguments: string };
}

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  latencyMs: { path: 'options.latencyMs', default: 0, unit: 'ms', min: 0 },
  toolResultChars: { path: 'options.toolResultChars', default: 500, unit: 'chars', min: 0, max: 1_000_000, safe: { max: 10_000 } },
});

export interface CompiledRule extends Omit<MockRule, 'match'> { regex: RegExp }

export const compileRules = (rules: readonly MockRule[] = []): CompiledRule[] =>
  rules.map(({ match, ...rest }) => ({ ...rest, regex: new RegExp(match, 'i') }));

const fill = (text: string, groups: readonly (string | undefined)[]) => text.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => groups[Number(n)] ?? '');

function fillValue(value: unknown, groups: readonly (string | undefined)[]): unknown {
  if (typeof value === 'string') return fill(value, groups);
  if (Array.isArray(value)) return value.map((v) => fillValue(v, groups));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillValue(v, groups)]));
  return value;
}

const offered = (tools: readonly ChatTool[], wanted: string) =>
  tools.find((t) => t.function.name === wanted || t.function.name.split('__').pop() === wanted);

/** The line `[1] (source) text` of a knowledge block, without its prefix. */
function firstPassage(messages: ChatRequest['messages']): string | undefined {
  for (const m of [...messages].reverse()) {
    if (m.role !== 'system' && m.role !== 'user') continue;
    const text = contentText(m.content);
    if (!text.includes('<context type="knowledge"')) continue;
    const line = /^\[1\](?: \([^)\n]*\))? ?(.*)$/m.exec(text);
    if (line?.[1]) return line[1];
  }
  return undefined;
}

/** Chooses the answer: tool result, first matching rule, forced tool call, knowledge passage, then echo. */
export function decide(req: ChatRequest, rules: readonly CompiledRule[], toolResultChars?: number): Decision {
  const last = req.messages.at(-1);
  if (last?.role === 'tool') return { content: contentText(last.content).trim().slice(0, limitValue(LIMITS.toolResultChars, toolResultChars)) };

  const tools = req.tool_choice === 'none' ? [] : (req.tools ?? []);
  const user = lastUserText(req.messages);
  for (const rule of rules) {
    const hit = rule.regex.exec(user);
    if (!hit) continue;
    const tool = rule.tool ? offered(tools, rule.tool) : undefined;
    if (tool) return { content: null, call: { name: tool.function.name, arguments: JSON.stringify(fillValue(rule.args ?? {}, hit)) } };
    if (rule.reply !== undefined) return { content: fill(rule.reply, hit) };
  }

  const choice = req.tool_choice;
  if (choice === 'required' || (typeof choice === 'object' && choice.type === 'function')) {
    const tool = typeof choice === 'object' ? tools.find((t) => t.function.name === choice.function.name) : tools[0];
    if (tool) return { content: null, call: { name: tool.function.name, arguments: '{}' } };
  }

  return { content: firstPassage(req.messages) ?? `You said: ${user}` };
}
