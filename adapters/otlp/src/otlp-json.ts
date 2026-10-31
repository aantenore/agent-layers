import type { Attributes, AttrValue } from '@agent-layers/core';

/** OTLP/JSON `AnyValue`. */
export type AnyValue =
  | { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: AnyValue[] } };
export interface KeyValue { key: string; value: AnyValue }

function toValue(v: AttrValue): AnyValue {
  if (Array.isArray(v)) return { arrayValue: { values: (v as (string | number | boolean)[]).map(toValue) } };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
}

/** OTLP/JSON `KeyValue[]` from attributes; undefined values are dropped. */
export function toAttributes(attrs: Attributes): KeyValue[] {
  return Object.entries(attrs).flatMap(([key, v]) => (v === undefined ? [] : [{ key, value: toValue(v) }]));
}

/**
 * Unix time in nanoseconds as a decimal string. Anchored once to the wall clock and advanced with the monotonic
 * clock, so a span never ends before it starts.
 */
export function createClock(): () => string {
  const origin = BigInt(Date.now()) * 1_000_000n - BigInt(Math.round(performance.now() * 1e6));
  return () => (origin + BigInt(Math.round(performance.now() * 1e6))).toString();
}
