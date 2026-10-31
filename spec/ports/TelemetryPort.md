# TelemetryPort

Layer: `telemetry` (L9 Telemetry & observability) · Version: 0.2.0 · Conformance: `checkTelemetry`

## Purpose

See what happened in a run: spans around the work, point-in-time events and numeric metrics, all tagged with the layer that produced them. A developer can answer "which layer was slow or failed" in any backend.

## Operations

- `span<T>(name: String, attrs: LayerAttributes, fn: (span: Span) → T, opts?: {parent?: TraceContext}) → T`
  Run `fn` inside a span. Resolves to the value of `fn`; if `fn` fails, records the error on the span and fails with the same error. `parent` is a remote parent (from another process): used only when no span of this adapter is active.
- `event(name: String, attrs: LayerAttributes) → ()`
  Record a point-in-time event.
- `metric(name: String, value: Number, attrs: LayerAttributes) → ()`
  Record a numeric measurement.
- `flush?() → ()`
  Optional. Push buffered data to the backend.
- `current?() → TraceContext?`
  Optional. The trace context of the active span, to send with outbound calls so the next process joins the trace. Adapters that do not keep trace ids leave it out.

A `Span` handed to `fn` has:

- `setAttributes(attrs: Attributes) → ()`
- `addEvent(name: String, attrs?: Attributes) → ()`
- `setError(err: Any) → ()` — mark the span failed. `fn` failing does this automatically.

## Data shapes

- `AttrValue`: String, Number, Boolean or a list of one of them. `Attributes` maps names to `AttrValue`; undefined values are dropped.
- `TraceContext`: `{traceparent: String, tracestate?: String}`, the two headers of [W3C Trace Context](https://www.w3.org/TR/trace-context/). `traceparent` is `00-<32 hex trace id>-<16 hex parent id>-<2 hex flags>`; a value that does not parse is ignored.
- `LayerAttributes`: `Attributes` that include `agent.layer`, one of the layer ids (`infra`, `llm`, `cache`, `harness`, `knowledge`, `tool`, `identity`, `guardrail`, `interface`, `telemetry`, `eval`).

## Semantics

- `agent.layer` is mandatory on every span, event and metric. The stack rejects a call without a valid layer id with a type error before it reaches an adapter, so adapters may assume it is present.
- Spans nest: a span started inside `fn` of another is its child. Concurrent spans must not mix their parents.
- `span` is transparent: it returns the value of `fn` and rethrows the same error object `fn` threw. A telemetry adapter never changes the outcome of the work.
- Telemetry must not break a run. `event`, `metric`, `flush` and span bookkeeping should not throw; the stack also isolates failing event and metric adapters.
- Secrets: attributes whose key looks like a secret (contains a word such as token, authorization, password, secret, api key, cookie or credential) are masked with `[redacted]` by the stack before adapters see them. Adapters must not log values of such keys even if they receive them, and must never log raw credentials or token values.
- Several telemetry adapters can be active at once; the stack fans each call out to all of them.
- Streams are traced with one span that ends when the stream ends, normally, by error or when the consumer stops early.
- Across processes: hosts read `traceparent` and `tracestate` from inbound requests into `CallContext.trace` and start their first span with it as `parent`; outbound adapters that call another service over HTTP send `current()` (else `CallContext.trace`) as those headers. With several adapters, the stack's `current()` is the first one that has a context. Trace context is not a credential, but its `tracestate` is the caller's: it is forwarded as received and never parsed for decisions.
- Names used by the stack include spans for model calls, cache lookups, router selection, knowledge search, guard checks, authorization and tool execution, each tagged with its own layer.

## Errors

- `span` rejects only with the error thrown by `fn`.
- `event`, `metric` and `flush` do not fail the caller.

## Escape hatch

`native()` returns the exporter or client. `Attributes` accepts any key; backend-specific names are allowed alongside the shared ones.

## Conformance

`checkTelemetry` verifies:

- `span` resolves to the value returned by `fn`, with `setAttributes` and `addEvent` callable on the span.
- Nested spans work.
- `span` rethrows the exact error that `fn` threw.
- `event` and `metric` complete without error.
- When present, `flush` completes.
- With a remote `parent`, `span` still resolves; when present, `current()` inside the span returns a valid `traceparent` with the parent's trace id, and outside any span returns nothing.

## Version history

- 0.2.0 — remote parent on `span`, optional `current()`, `CallContext.trace`: one trace across processes
- 0.1.0 — initial

Example adapters: `console-telemetry` (maps terminal output), `jsonl-telemetry` (maps JSON Lines files).
