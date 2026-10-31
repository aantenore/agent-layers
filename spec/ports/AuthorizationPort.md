# AuthorizationPort

Layer: `identity` (L6 Identity & access) · Version: 0.1.0 · Conformance: `checkAuthorization`

## Purpose

Decide whether a subject may perform an action on a resource, outside the agent code. A developer moves permissions to a policy engine, and the stack asks it before each governed action.

Boundary: this port answers "may they". "Who are they" is [IdentityPort](IdentityPort.md); "is this content acceptable" is [GuardPort](GuardPort.md).

## Operations

- `evaluate(req: AccessRequest, opts?: {signal?: Signal}) → AccessDecision`
  Return an allow or deny decision for the request.

## Data shapes

[AccessRequest](../schemas/access-request.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `subject` | {`type`: String, `id`: String, `properties?`: {`roles?`, `scopes?`, ...}} | Who acts. `type` is `user` or `agent`; `id` is the identity subject (or the agent name when there is no identity). |
| `action` | {`name`: String, `properties?`: object} | What they do. Tool calls use `call`. |
| `resource` | {`type`: String, `id`: String, `properties?`: {`risk?`: `read`/`write`/`exec`, `agent?`: String, ...}} | What it is done to. Tool calls use `type: tool` and the prefixed tool name as `id`; `properties` carry the tool's risk (missing risk is `exec`), the agent name and the tool's layer. |
| `context?` | {`args?`: Any, ...} | The arguments of the call, and other facts. |

[AccessDecision](../schemas/access-decision.json): `decision: Boolean` (required), `context?: {reason?: String, ...}`.

## Semantics

- Fail closed. If the engine cannot decide, the answer is deny. The stack also treats a rejection as a denial with the reason `authorization unavailable`, so a broken engine never opens access.
- Only `decision: true` allows. A missing or non-boolean decision is a deny.
- Order in the stack: local policy rules come first; only when they do not deny does this port get asked. When neither policy rules nor this port is configured, tool calls are allowed. A deployment that needs deny by default configures a catch-all deny rule or an authorization adapter.
- A deny carries a human-readable `context.reason` when available; the model sees it as part of an error result.
- The request is built from the run: roles and scopes come from the verified identity. Callers cannot add their own claims to it.
- Decisions are side-effect free and repeatable for the same request, except where the policy depends on time or external state.
- Approval is separate: an `ask` effect from the local policy is resolved by [ApprovalPort](ApprovalPort.md) before this port is asked.

## Errors

- Returned as a result: allow and deny, including every "not permitted" case.
- Rejects: engine unreachable, cancellation. The stack turns the first into a deny; cancellation propagates.

## Escape hatch

`properties` on subject, action and resource, and `context`, accept additional keys so engines can use attributes the contract does not name. `native()` returns the policy engine client.

## Conformance

`checkAuthorization` verifies:

- `evaluate` of a sample tool-call request resolves to a decision that validates against `access-decision.json`.
- Every fixture request expected to be allowed gets `decision: true`.
- Every fixture request expected to be denied gets `decision: false`.

## Version history

- 0.1.0 — initial

Example adapters: `rules-authorization` (local rule list).
