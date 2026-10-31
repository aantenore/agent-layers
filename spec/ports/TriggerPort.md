# TriggerPort

Layer: `interface` (L8 Interfaces, channels & triggers) · Version: 0.1.0 · Conformance: `checkTrigger`

## Purpose

Start runs without a person asking: on a schedule, on an event from another system, on a message in a queue. A developer lists triggers in configuration and the stack turns each firing into a run.

## Operations

- `start(handler: (trigger: Trigger) → ()) → TriggerHandle`
  Begin delivering triggers to `handler`. Returns once the source is armed.
- `TriggerHandle.close() → ()`
  Stop delivering and release the source.

## Data shapes

[Trigger](../schemas/trigger.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | String, required | Unique id of this firing. |
| `type` | String, required | Kind of event. |
| `source` | String, required | Where it came from. |
| `time?` | String (date-time) | When it happened. |
| `agent?` | String | Agent to run; when omitted the host chooses one. |
| `data?` | Any | Event payload. |

## Semantics

- The handler is asynchronous. The trigger waits for it to complete before it considers the firing handled; how it reacts to a failing handler (retry, drop, dead-letter) is the adapter's documented behaviour.
- Delivery guarantees are the adapter's. A source that can redeliver should keep `id` stable across redeliveries.
- `close` stops new deliveries. In-flight handlers may still finish.
- Reference host behaviour: the handler runs the trigger's `agent`, or the first configured agent when it is omitted; the trigger `id` becomes the run id; `data` is the run input (a string as is, anything else JSON-encoded). The run has no inbound credential, so it carries no user identity.
- The trigger does not decide what the agent does; it only says what happened and optionally which agent to run.

## Errors

- `start` rejects when the source cannot be armed (bad schedule expression, unreachable queue).
- A failure of the handler (for example a failed run) rejects the handler call; the adapter decides how to react.

## Escape hatch

`Trigger.data` carries the original event payload. `native()` returns the underlying scheduler or consumer.

## Conformance

`checkTrigger` verifies:

- `start` resolves to a handle.
- When a fire fixture is given: after firing, the handler was called, and every delivered trigger validates against `trigger.json`. Otherwise this part is skipped.
- `close` completes.

## Version history

- 0.1.0 — initial
