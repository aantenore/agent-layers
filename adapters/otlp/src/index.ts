import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { defineAdapter, defineLimits, limitProperties, limitValue, PORT_VERSIONS, timeoutSignal, type Attributes, type LayerAttributes, type LimitValue, type Span, type SpanOptions, type TelemetryPort, type TraceContext } from '@agent-layers/core';
import { MetricsAggregator } from './metrics.ts';
import { createClock, toAttributes, type KeyValue } from './otlp-json.ts';
import { deriveMetric, mapMetric, mapSpan, scrub } from './semconv.ts';
import { w3cCodec } from './w3c.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Options, validated against `optionsSchema` before `create` runs. */
export interface OtlpOptions {
  /** Collector base URL (`http://localhost:4318`) or the full `/v1/traces` URL. Default: `OTEL_EXPORTER_OTLP_ENDPOINT`, else `http://localhost:4318`. */
  endpoint?: string;
  /** Extra request headers, for example backend authentication. */
  headers?: Record<string, string>;
  /** `service.name` of the resource. Default: `OTEL_SERVICE_NAME`, else `agent-layers`. */
  serviceName?: string;
  /** Extra resource attributes. */
  resourceAttributes?: Record<string, string | number | boolean>;
  /** Export prompts, answers, tool arguments and results, and free-text reasons (default false). */
  captureContent?: boolean;
  /** Also export metrics to `/v1/metrics` (default true). */
  metrics?: boolean;
  /** Export interval for finished spans and changed metrics (default 2000 ms). Everything left is sent on `flush` and `close`. */
  intervalMs?: number;
  /** Send early when this many spans are waiting (default 512). */
  maxBatch?: number;
  /** Spans kept while the collector is slow or down; the oldest are dropped beyond it (default `maxBatch * 8`, at least `maxBatch`). */
  maxQueue?: LimitValue;
  /** Per-request timeout (default 10000 ms). */
  timeoutMs?: LimitValue;
  /** Characters of an error message exported with `captureContent` (default 200). */
  errorMessageChars?: number;
  /** Name spans `chat <model>`, `invoke_agent <agent>`, `execute_tool <tool>` as the GenAI conventions do; false keeps the `agent.*` span names (default true). */
  semconvNames?: boolean;
  /** An event outside any span: `span` exports it as a zero-length span (default), `drop` ignores it. */
  orphanEvents?: 'span' | 'drop';
}

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  intervalMs: { path: 'options.intervalMs', default: 2000, unit: 'ms', min: 1, safe: { min: 100, max: 60_000 } },
  maxBatch: { path: 'options.maxBatch', default: 512, unit: 'count', min: 1, safe: { max: 10_000 } },
  maxQueue: { path: 'options.maxQueue', default: null, unit: 'count', min: 1, unbounded: 'fail', safe: { max: 100_000 }, fallback: 'options.maxBatch * 8' },
  timeoutMs: { path: 'options.timeoutMs', default: 10_000, unit: 'ms', min: 1, unbounded: 'fail', safe: { max: 120_000 } },
  errorMessageChars: { path: 'options.errorMessageChars', default: 200, unit: 'chars', min: 0, max: 100_000, safe: { max: 1000 } },
});

export interface OtlpDeps { fetch?: FetchLike; env?: Record<string, string | undefined>; name?: string }

interface OpenSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /** Trace flags and vendor state inherited from a remote parent, propagated unchanged. */
  flags: string;
  tracestate?: string;
  name: string;
  attributes: Attributes;
  events: { time: string; name: string; attributes: Attributes }[];
  startNanos: string;
  startMs: number;
  error?: { type: string; message: string };
  ended: boolean;
}

interface FinishedSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  startTimeUnixNano: string; endTimeUnixNano: string; attributes: KeyValue[];
  events: { timeUnixNano: string; name: string; attributes: KeyValue[] }[];
  status?: { code: number; message?: string };
}

const STATUS_ERROR = 2;
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

/** Throws unless the endpoint is an absolute URL without credentials: those belong in `headers`. */
function assertPlainEndpoint(endpoint: string): void {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('otlp: endpoint is not a valid http(s) URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('otlp: endpoint is not a valid http(s) URL');
  if (url.username || url.password) throw new Error('otlp: the endpoint must not carry credentials; use headers');
}

/** Why an export failed, from a fixed set. Error text can echo URLs, headers or payloads, so it is never used. */
function failureReason(err: unknown): string {
  if (err instanceof RedirectRefused) return `redirects are not followed (HTTP ${err.status})`;
  if (err instanceof ExportStatusError) return `HTTP ${err.status}`;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  if (err instanceof InvalidResponse) return 'invalid response';
  return 'network error';
}

class ExportStatusError extends Error {
  readonly status: number;
  constructor(status: number) { super('export failed'); this.status = status; }
}
class InvalidResponse extends Error {}
class RedirectRefused extends ExportStatusError {}

function errorInfo(err: unknown): { type: string; message: string } {
  if (err instanceof Error) return { type: err.name || 'Error', message: err.message };
  return { type: 'Error', message: typeof err === 'string' ? err : 'error' };
}

/**
 * Factory: a TelemetryPort that exports OTLP/HTTP JSON, with no SDK. The span that is active when another one starts
 * becomes its parent (AsyncLocalStorage), so the spans of one run form a tree: run, then model, tool, guard and
 * knowledge work beneath it. Works with any collector, and with backends that take OTLP JSON directly.
 */
export function createOtlpTelemetry(options: OtlpOptions = {}, deps: OtlpDeps = {}): Omit<TelemetryPort, 'native'> & { native(): { traceparent(): string | undefined }; current(): TraceContext | undefined } {
  const env = deps.env ?? process.env;
  const captureContent = options.captureContent === true;
  const semconvNames = options.semconvNames !== false;
  const post = deps.fetch ?? fetch;
  const endpoint = options.endpoint ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
  assertPlainEndpoint(endpoint);
  const base = endpoint.replace(/\/+$/, '').replace(/\/v1\/(traces|metrics)$/, '');
  const tracesUrl = `${base}/v1/traces`;
  const metricsUrl = `${base}/v1/metrics`;
  const maxBatch = limitValue(LIMITS.maxBatch, options.maxBatch);
  const maxQueue = options.maxQueue === undefined ? maxBatch * 8 : limitValue(LIMITS.maxQueue, options.maxQueue);
  if (maxQueue < maxBatch) throw new Error('otlp: maxQueue must be at least maxBatch');
  const timeoutMs = limitValue(LIMITS.timeoutMs, options.timeoutMs);
  const intervalMs = limitValue(LIMITS.intervalMs, options.intervalMs);
  const errorMessageChars = limitValue(LIMITS.errorMessageChars, options.errorMessageChars);
  const resource = { attributes: toAttributes({ 'service.name': options.serviceName ?? env.OTEL_SERVICE_NAME ?? 'agent-layers', ...options.resourceAttributes }) };
  const scope = { name: '@agent-layers/adapter-otlp' };

  const now = createClock();
  const context = new AsyncLocalStorage<OpenSpan>();
  const metrics = options.metrics === false ? undefined : new MetricsAggregator(now);
  let pending: FinishedSpan[] = [];
  let chain: Promise<void> = Promise.resolve();
  let closed = false;
  const warned = new Set<string>();

  async function send(url: string, body: unknown, what: string): Promise<boolean> {
    try {
      const res = await post(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(body),
        // Redirects are not followed: the telemetry and the headers stay with the configured collector.
        redirect: 'manual',
        signal: timeoutSignal(timeoutMs),
      });
      if (typeof res?.ok !== 'boolean') throw new InvalidResponse();
      await res.body?.cancel().catch(() => {});
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new RedirectRefused(res.status);
      if (!res.ok) throw new ExportStatusError(res.status);
      return true;
    } catch (err) {
      if (!warned.has(what)) {
        warned.add(what);
        // The origin and a fixed reason only: the path, headers and error text stay out of the message.
        process.emitWarning(`OTLP ${what} export to ${new URL(url).origin} failed: ${failureReason(err)}`);
      }
      return false;
    }
  }

  async function exportOnce(): Promise<void> {
    if (pending.length) {
      const spans = pending;
      pending = [];
      await send(tracesUrl, { resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }] }, 'trace');
    }
    if (metrics?.dirty) {
      const list = metrics.take();
      if (!(await send(metricsUrl, { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: list }] }] }, 'metric'))) metrics.markDirty();
    }
  }
  const flush = () => (chain = chain.then(exportOnce));

  const timer = setInterval(() => { void flush(); }, intervalMs);
  timer.unref();

  /** The local active span is the parent; without one, a valid remote parent from another process. */
  function open(name: string, attrs: Attributes, remote?: TraceContext): OpenSpan {
    const local = context.getStore();
    const parsed = !local && remote ? w3cCodec.parse(remote) : undefined;
    const parent = local ?? (parsed ? { traceId: parsed.traceId, spanId: parsed.spanId, flags: parsed.flags ?? '01', ...(parsed.state ? { tracestate: parsed.state } : {}) } : undefined);
    return {
      traceId: parent?.traceId ?? hex(16),
      spanId: hex(8),
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      flags: parent?.flags ?? '01',
      ...(parent?.tracestate ? { tracestate: parent.tracestate } : {}),
      name,
      attributes: scrub(attrs, captureContent),
      events: [],
      startNanos: now(),
      startMs: performance.now(),
      ended: false,
    };
  }

  function finish(s: OpenSpan): void {
    if (s.ended) return;
    s.ended = true;
    if (closed) return;
    const endNanos = now();
    const attributes: Attributes = { ...s.attributes, ...(s.error ? { 'error.type': s.error.type } : {}) };
    const exported = mapSpan(s.name, attributes, !semconvNames);
    const derived = metrics && deriveMetric(s.name, exported.attributes, (performance.now() - s.startMs) / 1000, !!s.error);
    if (derived) metrics!.record(derived.name, derived.value, derived.attributes);
    pending.push({
      traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
      name: exported.name,
      kind: exported.kind,
      startTimeUnixNano: s.startNanos, endTimeUnixNano: endNanos,
      attributes: toAttributes(exported.attributes),
      events: s.events.map((e) => ({ timeUnixNano: e.time, name: e.name, attributes: toAttributes(e.attributes) })),
      ...(s.error ? { status: { code: STATUS_ERROR, ...(captureContent ? { message: s.error.message.slice(0, errorMessageChars) } : {}) } } : {}),
    });
    if (pending.length > maxQueue) pending.splice(0, pending.length - maxQueue);
    if (pending.length >= maxBatch) void flush();
  }

  function current(): TraceContext | undefined {
    const s = context.getStore();
    return s ? w3cCodec.format({ traceId: s.traceId, spanId: s.spanId, flags: s.flags, ...(s.tracestate ? { state: s.tracestate } : {}) }) : undefined;
  }

  return {
    name: deps.name ?? 'otlp',
    native: () => ({
      /** W3C `traceparent` of the active span, to propagate into outbound HTTP calls. */
      traceparent: () => current()?.parent,
    }),
    current,
    async span<T>(name: string, attrs: LayerAttributes, fn: (span: Span) => Promise<T>, opts?: SpanOptions): Promise<T> {
      const s = open(name, attrs, opts?.parent);
      const handle: Span = {
        setAttributes: (a) => { if (!s.ended) Object.assign(s.attributes, scrub(a, captureContent)); },
        addEvent: (n, a) => { if (!s.ended) s.events.push({ time: now(), name: n, attributes: a ? scrub(a, captureContent) : {} }); },
        setError: (err) => { if (!s.ended) s.error = errorInfo(err); },
      };
      try {
        const value = await context.run(s, () => fn(handle));
        finish(s);
        return value;
      } catch (err) {
        s.error = errorInfo(err);
        finish(s);
        throw err;
      }
    },
    event(name, attrs) {
      const active = context.getStore();
      if (active && !active.ended) {
        active.events.push({ time: now(), name, attributes: scrub(attrs, captureContent) });
      } else if (options.orphanEvents !== 'drop') {
        const s = open(name, { ...attrs, 'agent.event': true });
        finish(s);
      }
    },
    metric(name, value, attrs) {
      if (closed || !metrics) return;
      const mapped = mapMetric(name, scrub(attrs, false));
      metrics.record(mapped.name, value, mapped.attributes);
    },
    flush: () => flush(),
    async close() {
      clearInterval(timer);
      await flush();
      closed = true;
    },
  };
}

export const adapter = defineAdapter<'TelemetryPort', OtlpOptions>({
  layer: 'telemetry',
  port: 'TelemetryPort',
  name: 'otlp',
  direction: 'outbound',
  maps: { standard: 'OpenTelemetry OTLP/HTTP + GenAI semantic conventions' },
  portVersion: PORT_VERSIONS.TelemetryPort,
  tiers: ['prototype', 'production'],
  description: 'Exports nested traces and metrics over OTLP/HTTP JSON to any collector: Jaeger, Langfuse, Tempo, Prometheus.',
  optionsSchema: {
    type: 'object',
    properties: {
      endpoint: { type: 'string', minLength: 1 },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      serviceName: { type: 'string', minLength: 1 },
      resourceAttributes: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
      captureContent: { type: 'boolean' },
      metrics: { type: 'boolean' },
      ...limitProperties(LIMITS, {
        intervalMs: 'Export interval for finished spans and changed metrics',
        maxBatch: 'Send early when this many spans are waiting',
        maxQueue: 'Spans kept while the collector is slow or down; the oldest are dropped beyond it',
        timeoutMs: 'Per-request timeout',
        errorMessageChars: 'Characters of an error message exported with captureContent',
      }),
      semconvNames: { type: 'boolean' },
      orphanEvents: { enum: ['span', 'drop'] },
    },
    additionalProperties: false,
  },
  limits: LIMITS,
  create: (options, ctx) => createOtlpTelemetry(options, { env: ctx.env, name: ctx.name }),
});

export const adapters = [adapter];
