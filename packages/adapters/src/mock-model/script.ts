import { defineLimits, lastUserText, limitValue, messageText, type ModelRequest, type ResultPart, type ToolInfo } from '@agent-layers/core';

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
  text: string;
  /** Full tool name and arguments of the call, when it calls a tool. */
  call?: { tool: string; args: Record<string, unknown> };
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

const offered = (tools: readonly ToolInfo[], wanted: string) =>
  tools.find((t) => t.name === wanted || t.name.split('__').pop() === wanted);

/** The line `[1] (source) text` of a knowledge block, without its prefix. */
function firstPassage(messages: ModelRequest['messages']): string | undefined {
  for (const m of [...messages].reverse()) {
    if (m.role !== 'system' && m.role !== 'user') continue;
    const text = messageText(m);
    if (!text.includes('<context type="knowledge"')) continue;
    const line = /^\[1\](?: \([^)\n]*\))? ?(.*)$/m.exec(text);
    if (line?.[1]) return line[1];
  }
  return undefined;
}

/** Chooses the answer: tool result, first matching rule, forced tool call, knowledge passage, then echo. */
export function decide(req: ModelRequest, rules: readonly CompiledRule[], toolResultChars?: number): Decision {
  const last = req.messages.at(-1);
  if (last?.role === 'tool') {
    const text = last.parts.filter((p): p is ResultPart => p.type === 'result').map((p) => p.text).join('\n');
    return { text: text.trim().slice(0, limitValue(LIMITS.toolResultChars, toolResultChars)) };
  }

  const mode = req.toolMode ?? 'auto';
  const tools = mode === 'none' ? [] : (req.tools ?? []);
  const user = lastUserText(req.messages);
  for (const rule of rules) {
    const hit = rule.regex.exec(user);
    if (!hit) continue;
    const tool = rule.tool ? offered(tools, rule.tool) : undefined;
    if (tool) return { text: '', call: { tool: tool.name, args: fillValue(rule.args ?? {}, hit) as Record<string, unknown> } };
    if (rule.reply !== undefined) return { text: fill(rule.reply, hit) };
  }

  if (mode === 'required' || typeof mode === 'object') {
    const tool = typeof mode === 'object' ? tools.find((t) => t.name === mode.tool) : tools[0];
    if (tool) return { text: '', call: { tool: tool.name, args: {} } };
  }

  return { text: firstPassage(req.messages) ?? `You said: ${user}` };
}
