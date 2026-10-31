# TelemetryPort

Layer: `telemetry` (L9 Telemetry & observability) · Version: 1.0.0 · Conformance: `checkTelemetry`

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

The operations did not change at 1.0; what changed is the names the core emits.

## Data shapes

- `AttrValue`: String, Number, Boolean or a list of one of them. `Attributes` maps names to `AttrValue`; undefined values are dropped.
- `TraceContext`: `{parent: String, state?: String}`. Opaque to the core: the telemetry adapter that wrote the value owns its format and parses it, and channels copy it in and out unchanged. For `otlp` the values are the W3C Trace Context `traceparent` and `tracestate`. A value the adapter cannot parse is ignored and starts a new trace.
- `LayerAttributes`: `Attributes` that include `agent.layer`, one of the layer ids (`infra`, `llm`, `cache`, `harness`, `knowledge`, `tool`, `identity`, `guardrail`, `interface`, `telemetry`, `eval`).

## Names

The core emits only names that start with `agent.`. Standard names (`gen_ai.*`, `error.type`, `service.name`) are produced only by the telemetry adapter that speaks that standard, translating from the names below. Adapter spans and attributes use the adapter's namespace (`a2a.task.state`).

| Kind | Names |
| --- | --- |
| Span | `agent.run`, `agent.model.call`, `agent.cache.lookup`, `agent.router.select`, `agent.tool.call`, `agent.access.check`, `agent.guard.check`, `agent.knowledge.search` |
| Event | `agent.knowledge.error` |
| Metric | `agent.model.tokens` (with `agent.tokens.kind`: `input` or `output`), `agent.tool.calls`, `agent.access.decisions`, `agent.guard.actions` |
| Attribute, all | `agent.layer` (mandatory) |
| Attribute, run | `agent.run.id`, `agent.name`, `agent.run.status`, `agent.run.reason` (the stop code) |
| Attribute, model | `agent.model.requested`, `agent.model.used`, `agent.tokens.input`, `agent.tokens.output`, `agent.model.finish` |
| Attribute, tool | `agent.tool.name`, `agent.tool.source`, `agent.tool.outcome` |
| Attribute, guard | `agent.guard.name`, `agent.guard.stage`, `agent.guard.action` |
| Attribute, access | `agent.access.decision`, `agent.access.reason` |
| Attribute, other | `agent.cache.hit`, `agent.router.model`, `agent.knowledge.source`, `agent.knowledge.k`, `agent.knowledge.passages`, `agent.trigger.kind`, `agent.error` |

## Semantics

- `agent.layer` is mandatory on every span, event and metric. The stack rejects a call without a valid layer id with a type error before it reaches an adapter, so adapters may assume it is present.
- Spans nest: a span started inside `fn` of another is its child. Concurrent spans must not mix their parents.
- `span` is transparent: it returns the value of `fn` and rethrows the same error object `fn` threw. A telemetry adapter never changes the outcome of the work.
- Telemetry must not break a run. `event`, `metric`, `flush` and span bookkeeping should not throw; the stack also isolates failing event and metric adapters.
- Secrets: attributes whose key looks like a secret (contains a word such as token, authorization, password, secret, api key, cookie or credential) are masked with `[redacted]` by the stack before adapters see them. `sanitizeAttributes` trusts the `agent.tokens.*` attributes (token counts) and does not mask them. Adapters must not log values of such keys even if they receive them, and must never log raw credentials or token values.
- Several telemetry adapters can be active at once; the stack fans each call out to all of them.
- Streams are traced with one span that ends when the stream ends, normally, by error or when the consumer stops early.
- Across processes: hosts and channels copy the inbound trace context into `CallContext.trace` unchanged and start their first span with it as `parent`; outbound adapters that call another service send `current()` (else `CallContext.trace`), translated to the wire format they speak. With several adapters, the stack's `current()` is the first one that has a context. Trace context is not a credential, but its `state` is the caller's: it is forwarded as received and never parsed for decisions.
- `ext` keys of other adapters' shapes are not exported unless the producing adapter lists the key as safe in its descriptor; secret masking still applies.
- Evaluation and the CLI read these names, never `gen_ai.*`.

## Errors

- `span` rejects only with the error thrown by `fn`.
- `event`, `metric` and `flush` do not fail the caller.

## Escape hatch

`native()` returns the exporter or client. `Attributes` accepts any key; backend-specific names are allowed alongside the shared ones, in the adapter's namespace (for example `judge-eval.score`). Keys of `ext` that an adapter exports are declared in its descriptor's `ext.safe`. Translating the `agent.*` names to a standard's (the `otlp` adapter writes `gen_ai.*` and OpenTelemetry span names) is the adapter's built-in mapping; see [Mappings](../language.md#mappings) for the stack config `mappings` block.

## Conformance

`checkTelemetry` verifies:

- `span` resolves to the value returned by `fn`, with `setAttributes` and `addEvent` callable on the span.
- Nested spans work.
- `span` rethrows the exact error that `fn` threw.
- `event` and `metric` complete without error.
- When present, `flush` completes.
- With a remote `parent`, `span` still resolves; when present, `current()` inside the span returns a context, and outside any span returns nothing. The format of the context is not checked by the core.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): operations unchanged; the core emits only `agent.*` names (standard names come from the adapter that speaks the standard); `TraceContext` is `{parent, state?}`, opaque to the core
- 0.2.0 — remote parent on `span`, optional `current()`, `CallContext.trace`: one trace across processes
- 0.1.0 — initial

Example adapters: `console-telemetry` (maps terminal output), `jsonl-telemetry` (maps JSON Lines files).
