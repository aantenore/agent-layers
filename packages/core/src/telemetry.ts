import { isLayer, type Layer } from './layers.ts';
import type { Attributes, LayerAttributes, Span, TelemetryPort } from './ports/telemetry.ts';

const SECRET_KEY = /(^|[._-])(token|authorization|password|passwd|secret|api[_-]?key|apikey|cookie|credential)s?$|(^|[._-])(authorization|password|secret|api[_-]?key|cookie)[._-]/i;
/** Semantic-convention keys (token counts, token types) are known to be safe. */
const SAFE_PREFIX = 'gen_ai.';

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
    async span<T>(name: string, attrs: LayerAttributes, fn: (span: Span) => Promise<T>): Promise<T> {
      requireLayer('span', name, attrs);
      const safe = sanitizeAttributes(attrs);
      const spans: Span[] = [];
      const combined: Span = {
        setAttributes: (a) => spans.forEach((s) => quiet(() => s.setAttributes(sanitizeAttributes(a)))),
        addEvent: (n, a) => spans.forEach((s) => quiet(() => s.addEvent(n, a && sanitizeAttributes(a)))),
        setError: (e) => spans.forEach((s) => quiet(() => s.setError(e))),
      };
      const run = (i: number): Promise<T> =>
        i === ports.length ? fn(combined) : ports[i]!.span(name, safe, (s) => { spans.push(s); return run(i + 1); });
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
    async flush() { await Promise.allSettled(ports.map((p) => p.flush?.())); },
    async close() { await Promise.allSettled(ports.map((p) => p.close?.())); },
  };
}

function quiet(fn: () => void): void {
  try { fn(); } catch { /* telemetry must never break a run */ }
}

/** A finished span, event or metric, as recording adapters write it. */
export type TelemetryRecord =
  | { type: 'span'; name: string; layer: Layer; start: string; durationMs: number; status: 'ok' | 'error'; error?: string; attrs: Attributes; events: { name: string; attrs?: Attributes }[] }
  | { type: 'event'; name: string; layer: Layer; time: string; attrs: Attributes }
  | { type: 'metric'; name: string; layer: Layer; time: string; value: number; attrs: Attributes };

/** Builds a TelemetryPort from a function that writes finished records (console, files, test capture). */
export function recordingTelemetry(write: (record: TelemetryRecord) => void, name = 'recording'): TelemetryPort {
  return {
    name,
    async span(spanName, attrs, fn) {
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
        ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}), attrs: all, events,
      });
      try {
        const value = await fn(span);
        finish();
        return value;
      } catch (err) {
        error = err;
        finish();
        throw err;
      }
    },
    event: (n, attrs) => write({ type: 'event', name: n, layer: attrs['agent.layer'], time: new Date().toISOString(), attrs }),
    metric: (n, value, attrs) => write({ type: 'metric', name: n, layer: attrs['agent.layer'], time: new Date().toISOString(), value, attrs }),
  };
}
