import { sanitizeAttributes, type Attributes } from '@agent-layers/core';

/**
 * Attributes that carry what people typed, what the model answered, tool arguments and results, or free-text reasons
 * and errors. Exported only with `captureContent`.
 */
const CONTENT_KEY = /^gen_ai\.(input\.messages|output\.messages|system_instructions|tool\.definitions|tool\.call\.(arguments|result))$|(^|\.)(query|reason|message|content|prompt|text)$/;

/** Drops undefined values, masks secret-looking keys, and drops content unless `captureContent` is set. */
export function scrub(attrs: Attributes, captureContent: boolean): Attributes {
  const safe = sanitizeAttributes(attrs);
  return captureContent ? safe : Object.fromEntries(Object.entries(safe).filter(([k]) => !CONTENT_KEY.test(k)));
}

/** GenAI span names are `<operation> <target>`: `chat gpt-4o`, `invoke_agent support`, `execute_tool crm__get`. */
const TARGET: Readonly<Record<string, string>> = {
  chat: 'gen_ai.request.model',
  invoke_agent: 'gen_ai.agent.name',
  execute_tool: 'gen_ai.tool.name',
};

export function spanName(name: string, attrs: Attributes): string {
  const key = TARGET[name];
  const target = key ? attrs[key] : undefined;
  return typeof target === 'string' && target ? `${name} ${target}` : name;
}

/** OTLP SpanKind: 3 CLIENT for model calls, 1 INTERNAL for the rest. */
export const spanKind = (name: string): number => (name === 'chat' ? 3 : 1);
