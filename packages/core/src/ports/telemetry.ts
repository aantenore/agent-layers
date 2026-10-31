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

/**
 * Distributed trace context carried between processes. Opaque to the core: the telemetry adapter that wrote it owns
 * the format (W3C Trace Context for OTLP), and channels copy it in and out unchanged.
 */
export interface TraceContext {
  parent: string;
  state?: string;
}

export interface SpanOptions {
  /** Remote parent from another process; used only when no span of the adapter is active. Ignored when invalid. */
  parent?: TraceContext;
}

/** Spans around work, point-in-time events, numeric metrics. The core names its own with `agent.*`. */
export interface TelemetryPort extends PortBase {
  /** Run `fn` inside a span; resolves to its value and rethrows its error after recording it. */
  span<T>(name: string, attrs: LayerAttributes, fn: (span: Span) => Promise<T>, opts?: SpanOptions): Promise<T>;
  /** Trace context of the active span, for outbound calls; absent when the adapter keeps no trace ids. */
  current?(): TraceContext | undefined;
  event(name: string, attrs: LayerAttributes): void;
  metric(name: string, value: number, attrs: LayerAttributes): void;
  flush?(): Promise<void>;
}
