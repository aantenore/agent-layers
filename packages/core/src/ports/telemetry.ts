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

/** Spans around work, point-in-time events, numeric metrics. */
export interface TelemetryPort extends PortBase {
  /** Run `fn` inside a span; resolves to its value and rethrows its error after recording it. */
  span<T>(name: string, attrs: LayerAttributes, fn: (span: Span) => Promise<T>): Promise<T>;
  event(name: string, attrs: LayerAttributes): void;
  metric(name: string, value: number, attrs: LayerAttributes): void;
  flush?(): Promise<void>;
}
