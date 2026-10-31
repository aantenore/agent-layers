# StatePort

Layer: `harness` (L3 Agent runtime) · Version: 0.1.0 · Conformance: `checkState`

## Purpose

Keep what happened in a session as an append-only log, so a conversation can be resumed, replayed and audited, on any store.

## Operations

- `append(sessionId: String, events: [RunEvent]) → ()`
  Add events to the end of the session's log, creating the session if needed.
- `read(sessionId: String) → [RunEvent]`
  Return all events of the session, oldest first. An unknown session gives an empty list.
- `list(opts?: {limit?: Integer}) → [String]`
  Return known session ids, at most `limit` when given.
- `delete(sessionId: String) → ()`
  Remove the session and its events.

## Data shapes

`RunEvent` is `{type: String, ...}`; `type` is the only shared field and everything else is runtime-specific. See [RuntimePort](RuntimePort.md). The store keeps events as given, including unknown fields.

## Semantics

- Append-only: events are never modified or reordered. Two `append` calls leave their events in call order.
- `read` returns exactly what was appended, in order, with the same content.
- A session id is an opaque string chosen by the caller.
- `delete` is final; after it `read` returns an empty list and `list` no longer includes the id.
- Events may contain user content. Credentials must not be written into events by the runtime; the store does not need to scrub them.

## Errors

- Rejects: store unreachable, write failure.
- Resolves normally: unknown session on `read` (empty list).

## Escape hatch

`native()` returns the underlying store client. `RunEvent` allows extra fields.

## Conformance

`checkState` verifies:

- Two successive `append` calls, then `read` returns the events in order and equal to what was appended.
- `read` of an unknown session returns an empty list.
- `list` includes the session.
- After `delete`, `read` returns an empty list.

## Version history

- 0.1.0 — initial

Example adapters: `memory-state` (in-process map).
