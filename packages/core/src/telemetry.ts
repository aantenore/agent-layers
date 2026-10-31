import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { isLayer, type Layer } from './layers.ts';
import type { Attributes, LayerAttributes, Span, SpanOptions, TelemetryPort, TraceContext } from './ports/telemetry.ts';

const SECRET_KEY = /(^|[._-])(token|authorization|password|passwd|secret|api[_-]?key|apikey|cookie|credential)s?$|(^|[._-])(authorization|password|secret|api[_-]?key|cookie)[._-]/i;
/** Token counts and kinds are known to be safe, although their keys mention tokens. */
const SAFE_PREFIX = 'agent.tokens.';

/** Drops undefined values and masks attributes whose key looks like a secret. */
export function sanitizeAttributes<T extends Attributes>(attrs: T): T {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    out[k] = !k.startsWith(SAFE_PREFIX) && SECRET_KEY.test(k) ? '[redacted]' : v;
  }
  return out as T;
}

function requireLayer(kind: string, name: string, attrs: Attributes | undefined): asserts attrs is LayerAttributes {
  if (!attrs || !isLayer(attrs['agent.layer'])) throw new TypeError(`telemetry ${kind} "${name}" needs a valid agent.layer attribute`);
}

const noopSpan: Span = { setAttributes() {}, addEvent() {}, setError() {} };

/** Telemetry that records nothing. */
export const noopTelemetry: TelemetryPort = {
  name: 'noop',
  span: (_n, _a, fn) => fn(noopSpan),
  event() {},
  metric() {},
};

/**
 * Fan-out over several telemetry adapters. Enforces `agent.layer`, masks secret-looking attributes,
 * and keeps a failing event or metric adapter from breaking the run.
 */
export function createTelemetry(ports: readonly TelemetryPort[]): TelemetryPort {
  return {
    name: 'telemetry',
    async span<T>(name: string, attrs: LayerAttributes, fn: (span: Span) => Promise<T>, opts?: SpanOptions): Promise<T> {
      requireLayer('span', name, attrs);
      // The remote parent is opaque here: each telemetry adapter parses it in its own format, or ignores it.
      const parent = opts?.parent;
      const safe = sanitizeAttributes(attrs);
      const spans: Span[] = [];
      const combined: Span = {
        setAttributes: (a) => spans.forEach((s) => quiet(() => s.setAttributes(sanitizeAttributes(a)))),
        addEvent: (n, a) => spans.forEach((s) => quiet(() => s.addEvent(n, a && sanitizeAttributes(a)))),
        setError: (e) => spans.forEach((s) => quiet(() => s.setError(e))),
      };
      const run = (i: number): Promise<T> =>
        i === ports.length ? fn(combined) : ports[i]!.span(name, safe, (s) => { spans.push(s); return run(i + 1); }, parent ? { parent } : undefined);
      return run(0);
    },
    event(name, attrs) {
      requireLayer('event', name, attrs);
      const safe = sanitizeAttributes(attrs);
      for (const p of ports) quiet(() => p.event(name, safe));
    },
    metric(name, value, attrs) {
      requireLayer('metric', name, attrs);
      const safe = sanitizeAttributes(attrs);
      for (const p of ports) quiet(() => p.metric(name, value, safe));
    },
    current() {
      for (const p of ports) {
        let c: TraceContext | undefined;
        try { c = p.current?.(); } catch { c = undefined; }
        if (c) return c;
      }
      return undefined;
    },
    async flush() { await Promise.allSettled(ports.map((p) => p.flush?.())); },
    async close() { await Promise.allSettled(ports.map((p) => p.close?.())); },
  };
}

/**
 * The trace to hand to another process: the active span of `telemetry`, else `fallback` (the context the run was
 * started with). Undefined when neither has one. Outbound adapters write it in their protocol's format.
 */
export function activeTrace(telemetry?: TelemetryPort, fallback?: TraceContext): TraceContext | undefined {
  let c: TraceContext | undefined;
  try { c = telemetry?.current?.(); } catch { c = undefined; }
  return c ?? fallback;
}

function quiet(fn: () => void): void {
  try { fn(); } catch { /* telemetry must never break a run */ }
}

/** Trace and span ids of a recorded span or of the span an event happened in, when the recorder keeps trace ids. */
export type TraceIds = { traceId?: string; spanId?: string; parentSpanId?: string };

/** A finished span, event or metric, as recording adapters write it. */
export type TelemetryRecord =
  | ({ type: 'span'; name: string; layer: Layer; start: string; durationMs: number; status: 'ok' | 'error'; error?: string; attrs: Attributes; events: { name: string; attrs?: Attributes }[] } & TraceIds)
  | ({ type: 'event'; name: string; layer: Layer; time: string; attrs: Attributes } & Omit<TraceIds, 'parentSpanId'>)
  | { type: 'metric'; name: string; layer: Layer; time: string; value: number; attrs: Attributes };

/** Ids a trace codec reads from and writes to a TraceContext. `flags` and `state` are kept as they came. */
export interface TraceIdSet { traceId: string; spanId: string; flags?: string; state?: string }

/**
 * The format of trace contexts for a recorder that keeps trace ids. The core has none of its own: a telemetry adapter
 * that speaks a trace standard (W3C Trace Context) passes its codec.
 */
export interface TraceCodec {
  /** Ids of a context from another process; undefined when the value is not valid (the span then starts a new trace). */
  parse(trace: TraceContext): TraceIdSet | undefined;
  /** The context of a span, to hand to another process. */
  format(ids: TraceIdSet): TraceContext;
  /** A new trace id (default: 16 random bytes in hex). */
  newTraceId?(): string;
  /** A new span id (default: 8 random bytes in hex). */
  newSpanId?(): string;
}

const hexId = (bytes: number) => randomBytes(bytes).toString('hex');

/**
 * Builds a TelemetryPort from a function that writes finished records (console, files, test capture). With a `trace`
 * codec the records carry trace and span ids, spans nest like those of a tracing backend, a remote `parent` is honoured
 * and `current()` returns the active context, so a file shows one trace across processes. Keep it on one recorder per
 * stack: two recorders that both keep ids would start different traces for the same root span.
 */
export function recordingTelemetry(write: (record: TelemetryRecord) => void, name = 'recording', opts: { trace?: TraceCodec } = {}): TelemetryPort {
  const codec = opts.trace;
  const active = codec ? new AsyncLocalStorage<TraceIdSet>() : undefined;
  const newSpan = () => codec?.newSpanId?.() ?? hexId(8);
  const open = (parent?: TraceContext): { ctx: TraceIdSet; parentSpanId?: string } | undefined => {
    if (!active || !codec) return undefined;
    const local = active.getStore();
    if (local) return { ctx: { ...local, spanId: newSpan() }, parentSpanId: local.spanId };
    let remote: TraceIdSet | undefined;
    try { remote = parent ? codec.parse(parent) : undefined; } catch { remote = undefined; }
    if (remote) return { ctx: { ...remote, spanId: newSpan() }, parentSpanId: remote.spanId };
    return { ctx: { traceId: codec.newTraceId?.() ?? hexId(16), spanId: newSpan() } };
  };
  const ids = (o: ReturnType<typeof open>): TraceIds => (o ? { traceId: o.ctx.traceId, spanId: o.ctx.spanId, ...(o.parentSpanId ? { parentSpanId: o.parentSpanId } : {}) } : {});
  return {
    name,
    ...(active && codec ? {
      current: () => {
        const c = active.getStore();
        return c ? codec.format(c) : undefined;
      },
    } : {}),
    async span(spanName, attrs, fn, spanOpts) {
      const opened = open(spanOpts?.parent);
      const start = Date.now();
      const all: Attributes = { ...attrs };
      const events: { name: string; attrs?: Attributes }[] = [];
      let error: unknown;
      const span: Span = {
        setAttributes: (a) => Object.assign(all, a),
        addEvent: (n, a) => events.push(a ? { name: n, attrs: a } : { name: n }),
        setError: (e) => { error = e ?? new Error('error'); },
      };
      const finish = () => write({
        type: 'span', name: spanName, layer: attrs['agent.layer'], start: new Date(start).toISOString(),
        durationMs: Date.now() - start, status: error ? 'error' : 'ok',
        ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}), attrs: all, events, ...ids(opened),
      });
      try {
        const value = await (active && opened ? active.run(opened.ctx, () => fn(span)) : fn(span));
        finish();
        return value;
      } catch (err) {
        error = err;
        finish();
        throw err;
      }
    },
    event: (n, attrs) => {
      const c = active?.getStore();
      write({ type: 'event', name: n, layer: attrs['agent.layer'], time: new Date().toISOString(), attrs, ...(c ? { traceId: c.traceId, spanId: c.spanId } : {}) });
    },
    metric: (n, value, attrs) => write({ type: 'metric', name: n, layer: attrs['agent.layer'], time: new Date().toISOString(), value, attrs }),
  };
}
