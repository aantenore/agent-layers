import type { CallContext, PortBase } from './base.ts';
import type { ChatRequest } from './model.ts';

/** Key/value store for model responses. Values are JSON-serialisable. */
export interface CachePort extends PortBase {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
}

/** Picks the model id for a request. */
export interface RouterPort extends PortBase {
  select(req: ChatRequest, ctx: CallContext): string | Promise<string>;
}
