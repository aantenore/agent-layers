# TelemetryPort

Layer: `telemetry` (L9 Telemetry & observability) · Version: 0.1.0 · Conformance: `checkTelemetry`

## Purpose

See what happened in a run: spans around the work, point-in-time events and numeric metrics, all tagged with the layer that produced them. A developer can answer "which layer was slow or failed" in any backend.

## Operations

- `span<T>(name: String, attrs: LayerAttributes, fn: (span: Span) → T) → T`
  Run `fn` inside a span. Resolves to the value of `fn`; if `fn` fails, records the error on the span and fails with the same error.
- `event(name: String, attrs: LayerAttributes) → ()`
  Record a point-in-time event.
- `metric(name: String, value: Number, attrs: LayerAttributes) → ()`
  Record a numeric measurement.
- `flush?() → ()`
  Optional. Push buffered data to the backend.

A `Span` handed to `fn` has:

- `setAttributes(attrs: Attributes) → ()`
- `addEvent(name: String, attrs?: Attributes) → ()`
- `setError(err: Any) → ()` — mark the span failed. `fn` failing does this automatically.

## Data shapes

- `AttrValue`: String, Number, Boolean or a list of one of them. `Attributes` maps names to `AttrValue`; undefined values are dropped.
- `LayerAttributes`: `Attributes` that include `agent.layer`, one of the layer ids (`infra`, `llm`, `cache`, `harness`, `knowledge`, `tool`, `identity`, `guardrail`, `interface`, `telemetry`, `eval`).

## Semantics

- `agent.layer` is mandatory on every span, event and metric. The stack rejects a call without a valid layer id with a type error before it reaches an adapter, so adapters may assume it is present.
- Spans nest: a span started inside `fn` of another is its child. Concurrent spans must not mix their parents.
- `span` is transparent: it returns the value of `fn` and rethrows the same error object `fn` threw. A telemetry adapter never changes the outcome of the work.
- Telemetry must not break a run. `event`, `metric`, `flush` and span bookkeeping should not throw; the stack also isolates failing event and metric adapters.
- Secrets: attributes whose key looks like a secret (contains a word such as token, authorization, password, secret, api key, cookie or credential) are masked with `[redacted]` by the stack before adapters see them. Adapters must not log values of such keys even if they receive them, and must never log raw credentials or token values.
- Several telemetry adapters can be active at once; the stack fans each call out to all of them.
- Streams are traced with one span that ends when the stream ends, normally, by error or when the consumer stops early.
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

## Version history

- 0.1.0 — initial

Example adapters: `console-telemetry` (maps terminal output), `jsonl-telemetry` (maps JSON Lines files).
