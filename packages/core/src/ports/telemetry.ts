import type { Layer } from '../layers.ts';
import type { PortBase } from './base.ts';

export type AttrValue = string | number | boolean | string[] | number[] | boolean[];
export type Attributes = Record<string, AttrValue | undefined>;
/** Every span, event and metric names the layer it belongs to. */
export type LayerAttributes = Attributes & { 'agent.layer': Layer };

export interface Span {
  setAttributes(attrs: Attributes): void;
  addEvent(name: string, attrs?: Attributes): void;
  /** Mark the span failed. `fn` throwing does this automatically. */
  setError(err: unknown): void;
}

/** Distributed trace context, as the W3C Trace Context headers carry it between processes. */
export interface TraceContext {
  /** `00-<32 hex trace id>-<16 hex parent id>-<2 hex flags>`. */
  traceparent: string;
  tracestate?: string;
}

export interface SpanOptions {
  /** Remote parent from another process; used only when no span of the adapter is active. */
  parent?: TraceContext;
}

/** Spans around work, point-in-time events, numeric metrics. */
export interface TelemetryPort extends PortBase {
  /** Run `fn` inside a span; resolves to its value and rethrows its error after recording it. */
  span<T>(name: string, attrs: LayerAttributes, fn: (span: Span) => Promise<T>, opts?: SpanOptions): Promise<T>;
  /** Trace context of the active span, for outbound calls; absent when the adapter keeps no trace ids. */
  current?(): TraceContext | undefined;
  event(name: string, attrs: LayerAttributes): void;
  metric(name: string, value: number, attrs: LayerAttributes): void;
  flush?(): Promise<void>;
}
