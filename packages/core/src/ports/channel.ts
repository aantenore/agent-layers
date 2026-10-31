import type { CallContext, PortBase } from './base.ts';
import type { Caller } from './identity.ts';
import type { ModelPort } from './model.ts';
import type { RunEvent, RunInput, RunResult } from './runtime.ts';
import type { TraceContext } from './telemetry.ts';
import type { ToolPort } from './tool.ts';

/** What a channel can reach: the stack's agents, inbound identity and, for hosted channels, the governed ports. */
export interface ChannelHost {
  agents(): string[];
  run(agent: string, input: RunInput, ctx?: Partial<CallContext>): Promise<RunResult>;
  stream?(agent: string, input: RunInput, ctx?: Partial<CallContext>): AsyncIterable<RunEvent>;
  /** Verifies an inbound credential; undefined when no identity layer is configured. */
  verify?(credential: string): Promise<Caller>;
  /** The governed model (guards, cache, router, telemetry; no knowledge injection); absent without a model. */
  model?(): ModelPort;
  /** The governed tools (policy, approval, authorization, guards, credentials), knowledge sources included as read-only tools. */
  tools?(): ToolPort;
}

export interface ChannelHandle {
  url?: string;
  close(): Promise<void>;
  /** Resolves when the channel ends by itself (for example end of input on a terminal). */
  done?: Promise<void>;
}

/** One inbound request handled by a mounted channel or trigger: the envelope; the payload becomes a RunInput. */
export interface InboundContext {
  /** Caller verified by the host; absent only when the host accepted an anonymous request. */
  caller?: Caller;
  requestId: string;
  /** Aborted when the client goes away or the host's time limit expires. */
  signal: AbortSignal;
  /** Public origin of the host (`scheme://host:port`), for absolute URLs in documents the route returns. */
  origin: string;
  /** Trace context the request carried, copied unchanged. Pass it on as `CallContext.trace`. */
  trace?: TraceContext;
}

/** A route of a mounted channel or trigger, on the web-standard Request and Response types. */
export interface InboundRoute {
  /** Methods it answers; any when omitted. */
  methods?: string[];
  /** Exact path, or a prefix when it ends with `/*`. */
  path: string;
  /** Answered without authentication (discovery documents). Default false: the host authenticates the caller first. */
  public?: boolean;
  handle(req: Request, ctx: InboundContext): Promise<Response>;
}

/** The routes a mounted channel or trigger adds to a host server. */
export interface InboundMount {
  routes: InboundRoute[];
  close?(): Promise<void>;
}

/**
 * Exposes the stack's agents to people, apps or other agents. A channel serves itself (`serve`, a terminal), is mounted
 * on a host server (`mount`, an HTTP standard served by a gateway), or both.
 */
export interface ChannelPort extends PortBase {
  serve?(host: ChannelHost, opts?: { signal?: AbortSignal }): Promise<ChannelHandle>;
  mount?(host: ChannelHost): InboundMount | Promise<InboundMount>;
}
