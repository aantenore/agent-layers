import type { CallContext, Ext, PortBase } from './base.ts';

/** Message roles. Closed: config may add aliases, resolved by adapters at the edge. */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart { type: 'text'; text: string; ext?: Ext }
/** Image, audio or file. `data` is base64. Passed through by the core. */
export interface MediaPart { type: 'media'; mediaType: string; url?: string; data?: string; ext?: Ext }
/** A tool call the model made. `invalid` holds the raw text when the model's arguments did not parse. */
export interface CallPart { type: 'call'; id: string; tool: string; args: Record<string, unknown>; invalid?: string; ext?: Ext }
/** The result answering one call. */
export interface ResultPart { type: 'result'; callId: string; ok: boolean; text: string; data?: unknown; ext?: Ext }
/** The model's reasoning, when the backend returns it. Kept in history, never shown as output. */
export interface ReasoningPart { type: 'reasoning'; text: string; ext?: Ext }
/** Adapter-defined part, `<namespace>.<name>`. Passed through untouched, never read by the core. */
export interface ExtPart { type: `${string}.${string}`; [k: string]: unknown }

export type CorePart = TextPart | MediaPart | CallPart | ResultPart | ReasoningPart;
export type Part = CorePart | ExtPart;

/**
 * One message. `parts` is always a list. `system`: text only; `user`: text and media; `assistant`: text, reasoning and
 * calls; `tool`: results only.
 */
export interface Message { role: Role; parts: Part[]; ext?: Ext }

/** What the model sees of a tool. `params` is the JSON Schema of the arguments object. */
export interface ToolInfo { name: string; description?: string; params: Record<string, unknown> }

export type ToolMode = 'auto' | 'none' | 'required' | { tool: string };

/** Sampling settings. The same shape is `AgentSpec.settings`. */
export interface ModelSettings { temperature?: number; maxOutputTokens?: number; stop?: string[] }

/** Schema: spec/schemas/model-request.json. */
export interface ModelRequest {
  model: string;
  messages: Message[];
  tools?: ToolInfo[];
  /** Default `auto`. */
  toolMode?: ToolMode;
  settings?: ModelSettings;
  ext?: Ext;
}

/** Why the model stopped. Core values; config may add values `like` one of them. */
export type Finish = 'end' | 'limit' | 'tools' | 'refused' | 'other' | (string & {});

/** Token counts. Cached or reasoning tokens go in `ext`. */
export interface Usage { inputTokens: number; outputTokens: number; ext?: Ext }

/** Schema: spec/schemas/model-reply.json. One answer per call. */
export interface ModelReply {
  model: string;
  /** Role `assistant`. */
  message: Message;
  /** `tools` exactly when the message has at least one call part. */
  finish: Finish;
  usage?: Usage;
  /** Backend response id. */
  id?: string;
  ext?: Ext;
}

/** One streamed fragment. Schema: spec/schemas/model-delta.json. A stream ends with exactly one `end`. */
export type ModelDelta =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  /** Fragments of call `index`; `argsText` fragments concatenate to the JSON arguments. */
  | { type: 'call'; index: number; id?: string; tool?: string; argsText?: string }
  | { type: 'end'; finish: Finish; usage?: Usage; model?: string; id?: string; ext?: Ext };

/** Models (layer `llm`, with `cache` in front): one model call, optionally streamed. */
export interface ModelPort extends PortBase {
  chat(req: ModelRequest, ctx: CallContext): Promise<ModelReply>;
  stream?(req: ModelRequest, ctx: CallContext): AsyncIterable<ModelDelta>;
}
