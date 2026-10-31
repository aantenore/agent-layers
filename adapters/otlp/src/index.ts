import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { defineAdapter, PORT_VERSIONS, traceContext, type Attributes, type LayerAttributes, type Span, type SpanOptions, type TelemetryPort, type TraceContext } from '@agent-layers/core';
import { MetricsAggregator } from './metrics.ts';
import { createClock, toAttributes, type KeyValue } from './otlp-json.ts';
import { scrub, spanKind, spanName } from './semconv.ts';

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
  /** Per-request timeout (default 10000 ms). */
  timeoutMs?: number;
  /** Name spans `chat <model>`, `invoke_agent <agent>`, `execute_tool <tool>` as the GenAI conventions do (default true). */
  semconvNames?: boolean;
  /** An event outside any span: `span` exports it as a zero-length span (default), `drop` ignores it. */
  orphanEvents?: 'span' | 'drop';
}

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
  const maxBatch = options.maxBatch ?? 512;
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
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (typeof res?.ok !== 'boolean') throw new InvalidResponse();
      await res.body?.cancel().catch(() => {});
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

  const timer = setInterval(() => { void flush(); }, options.intervalMs ?? 2000);
  timer.unref();

  /** The local active span is the parent; without one, a valid remote parent from another process. */
  function open(name: string, attrs: Attributes, remote?: TraceContext): OpenSpan {
    const local = context.getStore();
    const parsed = !local && remote ? traceContext(remote.traceparent, remote.tracestate) : undefined;
    const [, remoteTrace, remoteSpan, remoteFlags] = parsed ? parsed.traceparent.split('-') : [];
    const parent = local ?? (parsed ? { traceId: remoteTrace!, spanId: remoteSpan!, flags: remoteFlags!, ...(parsed.tracestate ? { tracestate: parsed.tracestate } : {}) } : undefined);
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
    const operation = attributes['gen_ai.operation.name'];
    if (metrics && operation === 'chat') {
      metrics.record('gen_ai.client.operation.duration', (performance.now() - s.startMs) / 1000, {
        'agent.layer': 'llm', 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': attributes['gen_ai.request.model'], 'error.type': attributes['error.type'],
      });
    } else if (metrics && operation === 'invoke_agent') {
      metrics.record('agent.runs', 1, {
        'agent.layer': 'harness', 'gen_ai.agent.name': attributes['gen_ai.agent.name'],
        'run.status': attributes['run.status'] ?? (s.error ? 'failed' : undefined),
      });
    }
    pending.push({
      traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
      name: semconvNames ? spanName(s.name, attributes) : s.name,
      kind: spanKind(typeof operation === 'string' ? operation : s.name),
      startTimeUnixNano: s.startNanos, endTimeUnixNano: endNanos,
      attributes: toAttributes(attributes),
      events: s.events.map((e) => ({ timeUnixNano: e.time, name: e.name, attributes: toAttributes(e.attributes) })),
      ...(s.error ? { status: { code: STATUS_ERROR, ...(captureContent ? { message: s.error.message.slice(0, 200) } : {}) } } : {}),
    });
    if (pending.length > maxBatch * 8) pending.splice(0, pending.length - maxBatch * 8);
    if (pending.length >= maxBatch) void flush();
  }

  return {
    name: deps.name ?? 'otlp',
    native: () => ({
      /** W3C `traceparent` of the active span, to propagate into outbound HTTP calls. */
      traceparent: () => { const s = context.getStore(); return s ? `00-${s.traceId}-${s.spanId}-${s.flags}` : undefined; },
    }),
    current() {
      const s = context.getStore();
      return s ? { traceparent: `00-${s.traceId}-${s.spanId}-${s.flags}`, ...(s.tracestate ? { tracestate: s.tracestate } : {}) } : undefined;
    },
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
      if (!closed) metrics?.record(name, value, scrub(attrs, false));
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
      intervalMs: { type: 'integer', minimum: 1 },
      maxBatch: { type: 'integer', minimum: 1 },
      timeoutMs: { type: 'integer', minimum: 1 },
      semconvNames: { type: 'boolean' },
      orphanEvents: { enum: ['span', 'drop'] },
    },
    additionalProperties: false,
  },
  create: (options, ctx) => createOtlpTelemetry(options, { env: ctx.env, name: ctx.name }),
});

export const adapters = [adapter];
