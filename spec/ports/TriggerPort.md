# TriggerPort

Layer: `interface` (L8 Interfaces, channels & triggers) · Version: 1.0.0 · Conformance: `checkTrigger`

## Purpose

Start runs without a person asking: on a schedule, on an event from another system, on a message in a queue. A developer lists triggers in configuration and the stack turns each firing into a run.

## Operations

A trigger implements `start` (it pulls or schedules by itself), `mount` (it receives events on a host server), or both.

- `start?(handler: (trigger: Trigger) → ()) → TriggerHandle`
  Begin delivering triggers to `handler`. Returns once the source is armed.
- `mount?(sink: TriggerSink) → InboundMount`
  Return the routes that receive events on a host server; see [ChannelPort](ChannelPort.md) for `InboundMount`.

`TriggerSink`, provided by the host:

- `agents() → [String]` — the agents a trigger may name.
- `accept(trigger: Trigger, ctx?: {caller?: Caller}) → {runId: String}` — accept the trigger and start its run in
  the background. Rejects when it cannot be accepted: an unknown agent, or no caller where the host requires one
  (a production-tier host never runs a trigger anonymously).
- `verify?(credential: String) → Caller` — verify the trigger's own credential (a service credential from its
  configuration) through the identity port.
- `TriggerHandle.close() → ()`
  Stop delivering and release the source.

## Data shapes

[Trigger](../schemas/trigger.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | String, required | Unique id of this firing, assigned by the SDK. |
| `kind` | String, required | Kind of event. |
| `source` | String, required | Where it came from. |
| `at?` | String (ISO 8601 time) | When it happened. |
| `agent?` | String | Agent to run; when omitted the host chooses one. |
| `data?` | Any | Event payload. |
| `ext?` | Ext | Source-specific fields. The upstream event id goes here (for example `cloudevents.id`), so redeliveries can be told apart. |

## Semantics

- The handler is asynchronous. The trigger waits for it to complete before it considers the firing handled; how it reacts to a failing handler (retry, drop, dead-letter) is the adapter's documented behaviour.
- Delivery guarantees are the adapter's. A source that can redeliver keeps the upstream event id stable in `ext` so a consumer can deduplicate; `id` is the SDK's own.
- `close` stops new deliveries. In-flight handlers may still finish.
- Reference host behaviour: the handler runs the trigger's `agent`, or the first configured agent when it is omitted; the trigger `id` becomes the run id; `data` is the run input (a string as is, anything else JSON-encoded). The run has no inbound credential: it carries the caller the host was started with (a service caller), or none.
- The trigger does not decide what the agent does; it only says what happened and optionally which agent to run.

## Errors

- `start` rejects when the source cannot be armed (bad schedule expression, unreachable queue).
- A failure of the handler (for example a failed run) rejects the handler call; the adapter decides how to react.

## Escape hatch

`Trigger.data` carries the original event payload and `Trigger.ext` the source's own attributes (`cloudevents.id`, `cloudevents.subject`, ...); keys are namespaced and declared in the adapter descriptor's `ext.produces` / `ext.reads`. `native()` returns the underlying scheduler or consumer. How an event document becomes a trigger beyond the adapter's built-in translation goes through the stack config `mappings` block (`triggers.<name>`); see [Mappings](../language.md#mappings).

## Conformance

`checkTrigger` verifies:

- The trigger has `start` or `mount`.
- `start`, when present, resolves to a handle and `close` completes.
- `mount`, when present, resolves to at least one well-formed route.
- When a fire fixture is given (for `start` or for `mount`): the trigger was delivered, and every delivered trigger validates against `trigger.json`. Otherwise this part is skipped.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): `Trigger.kind` (was `type`) and `at` (was `time`); the upstream event id goes in `ext`; `TriggerSink.accept(trigger, {caller})`
- 0.1.0 — initial
- 0.2.0 — `start` is optional; `mount` receives events on a host server through a `TriggerSink`; the reference host runs triggers with the identity it was started with
