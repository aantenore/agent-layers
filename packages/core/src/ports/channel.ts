import type { CallContext, PortBase } from './base.ts';
import type { Identity } from './identity.ts';
import type { RunEvent, RunInput, RunResult } from './runtime.ts';

/** What a channel can reach: the stack's agents and inbound identity. */
export interface ChannelHost {
  agents(): string[];
  run(agent: string, input: RunInput, ctx?: Partial<CallContext>): Promise<RunResult>;
  stream?(agent: string, input: RunInput, ctx?: Partial<CallContext>): AsyncIterable<RunEvent>;
  /** Verifies an inbound credential; undefined when no identity layer is configured. */
  verify?(credential: string): Promise<Identity>;
}

export interface ChannelHandle {
  url?: string;
  close(): Promise<void>;
  /** Resolves when the channel ends by itself (for example end of input on a terminal). */
  done?: Promise<void>;
}

/** Exposes the stack's agents to people, apps or other agents. */
export interface ChannelPort extends PortBase {
  serve(host: ChannelHost, opts?: { signal?: AbortSignal }): Promise<ChannelHandle>;
}
