# ApprovalPort

Layer: `identity` (L6 Identity & access) · Version: 0.1.0 · Conformance: `checkApproval`

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

## Data shapes

[Approval](../schemas/approval.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | String, required | Assigned by the port. |
| `status` | `pending`, `approved`, `denied` or `expired`, required | State of the approval. |
| `request` | ApprovalRequest, required | What is being asked. |
| `decidedBy?` | String | Who answered. |
| `reason?` | String | Why. |

`ApprovalRequest`: `access: AccessRequest` (see [AuthorizationPort](AuthorizationPort.md)), `agent: String`, `runId: String`, `reason?: String`, `expiresAt?: String` (time after which a pending approval becomes `expired`).

## Semantics

- A new approval is always `pending`.
- Status changes once: `pending` → `approved`, `denied` or `expired`. A decided approval stays decided; deciding it again is an error.
- `expired` is derived: a pending approval past its `expiresAt` reads as `expired` without any call being made. A port may also apply a default lifetime.
- `wait` must not poll in a way that misses a decision: it returns as soon as `decide` is called. On timeout it returns the pending approval and does not fail; the caller decides what to do.
- In the tool pipeline: for an `ask` effect, the stack calls `request`. Without an approval port, `ask` denies. With one, the call waits up to a configured time (default: it does not wait). If the answer is still pending, the call returns an error result naming the approval id, and the run may continue or retry once a human has answered. Only `approved` lets the call proceed; `denied` and `expired` deny, with the reason when present.
- Approvals contain the tool arguments. Keep them as private as the run itself and do not log them beyond what the audit trail needs.
- Answering is not tied to a channel: any component with access to `decide` (a chat button, a web page, a command) can answer.

## Errors

- Resolves to nothing: `get` of an unknown id.
- Rejects: `decide` or `wait` for an unknown id; `decide` for an approval that is no longer pending; store unreachable; cancellation of `wait`.
- Returned as a result: `denied` and `expired` are statuses, not errors.

## Escape hatch

`AccessRequest.properties` and `context` pass through inside the request. `native()` returns the underlying store.

## Conformance

`checkApproval` verifies:

- `request` returns an approval that validates against `approval.json` and is `pending`.
- `get` returns the same approval; `get` of an unknown id resolves to nothing.
- `wait` with a short timeout on an undecided approval resolves with status `pending`.
- A `wait` in progress resolves with `approved` after `decide` approves the approval, and `decide` returns status `approved`.

## Version history

- 0.1.0 — initial

Example adapters: `memory-approval` (in-process store).
