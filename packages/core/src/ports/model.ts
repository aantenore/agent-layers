import type { CallContext, PortBase } from './base.ts';

/** Content part of a message. Only `text` parts are interpreted by the core; others pass through. */
export type ContentPart = { type: 'text'; text: string } | { type: string; [k: string]: unknown };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'developer'; content: string | ContentPart[]; name?: string }
  | { role: 'user'; content: string | ContentPart[]; name?: string }
  | { role: 'assistant'; content: string | ContentPart[] | null; tool_calls?: ToolCall[]; name?: string }
  | { role: 'tool'; content: string | ContentPart[]; tool_call_id: string };

export interface ChatTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens?: number }

/** Chat request. Field names follow the most common wire format; `extra` carries backend-specific fields. */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  stop?: string[];
  /** Passed through untouched to the backend (merged into its request body). */
  extra?: Record<string, unknown>;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | (string & {});

export interface ChatChoice {
  index: number;
  message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };
  finish_reason: FinishReason | null;
}

export interface ChatResponse {
  id?: string;
  model: string;
  choices: ChatChoice[];
  usage?: Usage;
  /** Backend-specific fields of the response. */
  extra?: Record<string, unknown>;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface ChatChunk {
  id?: string;
  model?: string;
  choices: { index: number; delta: { role?: 'assistant'; content?: string | null; tool_calls?: ToolCallDelta[] }; finish_reason?: FinishReason | null }[];
  usage?: Usage;
}

/** Models (layer `llm`, with `cache` in front): one chat completion, optionally streamed. */
export interface ModelPort extends PortBase {
  chat(req: ChatRequest, ctx: CallContext): Promise<ChatResponse>;
  stream?(req: ChatRequest, ctx: CallContext): AsyncIterable<ChatChunk>;
}
