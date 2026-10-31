# RouterPort

Layer: `cache` (L2 Model access (routing, fallback, quotas, cache)) · Version: 0.1.0 · Conformance: `checkRouter`

## Purpose

Decide which model serves a request, so cost and latency policy lives outside agent definitions. An agent asks for a model; the router may pick a different one.

## Operations

- `select(req: ChatRequest, ctx: CallContext) → String`
  Return the id of the model to use for this request. May answer immediately or asynchronously.

`ChatRequest` is defined in [ModelPort](ModelPort.md); `CallContext` in the [port index](README.md#common-types).

## Data shapes

Input is the (already input-guarded) chat request and the call context, so a router can decide on the model asked for, the size of the conversation, the tools offered, the agent or the caller's identity. Output is a non-empty model id.

## Semantics

- The router runs after the cache lookup and before the model call. A cache hit never reaches the router.
- Returning the id already in `req.model` keeps the request unchanged; returning another id replaces `req.model` for this call only.
- `select` does not modify the request and has no other side effects visible to the caller.
- The router must return an id for every request. Falling back to `req.model` is the safe default.
- The selection is recorded in a span with the chosen model id.

## Errors

- Rejects: the router cannot decide (failed policy lookup, quota service down). The model call then fails; the stack does not guess a model.

## Escape hatch

`native()` returns the underlying policy engine or client, if any.

## Conformance

`checkRouter` verifies, for each fixture request:

- `select` resolves to a non-empty string.
- When an expected id is given for that request, the result equals it.

## Version history

- 0.1.0 — initial

Example adapters: `static-router` (static model mapping).
