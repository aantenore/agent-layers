# ApprovalPort

Layer: `identity` (L6 Identity & access) · Version: 1.1.0 · Conformance: `checkApproval`

## Purpose

Put a human in the loop for actions the policy marks `ask`. Approvals are durable records: a request can be answered later, from any channel, by someone other than the person who started the run.

## Operations

- `request(req: ApprovalRequest) → Approval`
  Create an approval in status `pending` and return it.
- `get(id: String) → Approval?`
  Return the approval, or nothing for an unknown id.
- `decide(id: String, decision: {approved: Boolean, by?: String, reason?: String}) → Approval`
  Record the answer and return the updated approval: status `approved` or `denied`.
- `wait(id: String, opts?: {timeoutMs?: Integer, signal?: Signal}) → Approval`
  Resolve when the approval is no longer pending, or with the still pending approval when `timeoutMs` elapses.
- `lookup(key: String, opts?: {consume?: Boolean}) → Approval?` (optional, since 1.1.0)
  Return the latest approval requested with this `key` that has not been consumed, or nothing. With `consume: true`, an approved approval is marked consumed in the same step and is never returned again.

## Data shapes

[Approval](../schemas/approval.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | String, required | Assigned by the port. |
| `status` | `pending`, `approved`, `denied` or `expired`, required | State of the approval. |
| `request` | ApprovalRequest, required | What is being asked. |
| `decidedBy?` | String | Who answered. |
| `reason?` | String | Why. |
| `ext?` | Ext | Adapter-specific fields. |

`ApprovalRequest`: `question: AccessQuestion` (see [AuthorizationPort](AuthorizationPort.md)), `agent: String`, `runId: String` (these three required), `reason?: String`, `expiresAt?: String` (ISO 8601 time after which a pending approval becomes `expired`), `key?: String` (identifies the call being approved; since 1.1.0), `ext?: Ext`.

## Semantics

- A new approval is always `pending`.
- Status changes once: `pending` → `approved`, `denied` or `expired`. A decided approval stays decided; deciding it again is an error.
- `expired` is derived: a pending approval past its `expiresAt` reads as `expired` without any call being made. A port may also apply a default lifetime.
- `wait` must not poll in a way that misses a decision: it returns as soon as `decide` is called. On timeout it returns the pending approval and does not fail; the caller decides what to do.
- `lookup` only sees approvals requested with a `key`. Consuming affects only `approved` approvals: a pending, denied or expired one stays visible. Consuming is atomic: two concurrent `lookup(key, {consume: true})` calls never both receive the same approved approval.
- In the tool pipeline: for an `ask` effect, the stack computes the request key, a stable hash of the session id (the run id when there is no session), the caller (`kind:id`, or `anonymous`) and the access question with the call's arguments. When the port has `lookup`, the stack first calls `lookup(key, {consume: true})`:
  - `approved`: the call proceeds, once; the approval is consumed, so the next identical call asks again.
  - `denied`: the call is denied, with the reason when present; the denial stands for that key.
  - `pending`: the call returns the same approval id; no new approval is created.
  - `expired` or nothing: the stack calls `request` with the key.
  Without an approval port, `ask` denies. With one, the call waits up to a configured time (default: it does not wait); an approval decided `approved` during that wait is consumed by the waiting call. If the answer is still pending, the tool result has `ok: false`, carries `ext["sdk.approval"]` (the approval id) and `ext["sdk.outcome"] = "pending"`, and the runtime may end the run as `waiting` (see [RuntimePort](RuntimePort.md)). A later run in the same session, by the same caller, that makes the same call (same tool, same arguments) gets the decision. Only `approved` lets the call proceed; `denied` and `expired` deny, with the reason when present. A port without `lookup` (1.0.0) is asked again on every call.
- Approvals contain the tool arguments. Keep them as private as the run itself and do not log them beyond what the audit trail needs.
- Answering is not tied to a channel: any component with access to `decide` (a chat button, a web page, a command) can answer.

## Errors

- Resolves to nothing: `get` of an unknown id.
- Rejects: `decide` or `wait` for an unknown id; `decide` for an approval that is no longer pending; store unreachable; cancellation of `wait`.
- Returned as a result: `denied` and `expired` are statuses, not errors.

## Escape hatch

`ext` on the request and the approval passes through; keys are namespaced and declared in the adapter descriptor's `ext.produces` / `ext.reads`. `native()` returns the underlying store.

## Conformance

`checkApproval` verifies:

- `request` returns an approval that validates against `approval.json` and is `pending`.
- `get` returns the same approval; `get` of an unknown id resolves to nothing.
- `wait` with a short timeout on an undecided approval resolves with status `pending`.
- A `wait` in progress resolves with `approved` after `decide` approves the approval, and `decide` returns status `approved`.
- When the port has `lookup`: an unknown key resolves to nothing; an approval requested with a key is found by it; consuming leaves a pending approval in place; an approved approval is returned once with `consume` and never again; a denial survives `consume`.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.1.0 — optional `lookup(key, {consume})` and `ApprovalRequest.key`: a later identical call in the same session uses the decision instead of asking again
- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): `ApprovalRequest.question` (was `access`), an `AccessQuestion`; pending approvals surface as `ext["sdk.approval"]` and the run status `waiting`
- 0.2.0 — the embedded access request may carry an `anonymous` subject; `subject.properties.authenticated` added
- 0.1.0 — initial

Example adapters: `memory-approval` (in-process store).
