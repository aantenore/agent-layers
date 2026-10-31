# AuthorizationPort

Layer: `identity` (L6 Identity & access) · Version: 1.0.0 · Conformance: `checkAuthorization`

## Purpose

Decide whether a caller may perform an action on a target, outside the agent code. A developer moves permissions to a policy engine, and the stack asks it before each governed action.

Boundary: this port answers "may they". "Who are they" is [IdentityPort](IdentityPort.md); "is this content acceptable" is [GuardPort](GuardPort.md).

## Operations

- `evaluate(q: AccessQuestion, opts?: {signal?: Signal}) → AccessDecision`
  Return an allow or deny decision for the question.

## Data shapes

[AccessQuestion](../schemas/access-question.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `caller` | public [Caller](../schemas/caller.json) (no `credential`) or `{kind: "anonymous", id: "anonymous", roles: [], scopes: []}` | Who acts. Anonymous is explicit, never the agent. |
| `action` | String, required | What they do. Tool calls use `call`. Config may add values that behave like `call`. |
| `target` | {`kind`, `id`, `layer`, `risk`, `agent`, `attrs?`} | What it is done to. Tool calls use `kind: "tool"` and the prefixed tool name as `id`; `layer` is the tool's layer, `risk` its risk (missing risk is `exec`), `agent` the agent name, `attrs` the tool's [Attrs](README.md#language). |
| `args?` | {String: Any} | The arguments of the call. Present only when the adapter is configured to send arguments. |
| `ext?` | Ext | Adapter-specific context. |

[AccessDecision](../schemas/access-decision.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `allowed` | Boolean, required | The decision. |
| `reason?` | String | Why. Kept inside the stack, never shown to the caller. |
| `ext?` | Ext | Engine-specific fields. |

## Semantics

- Fail closed. If the engine cannot decide, the answer is deny. The stack also treats a rejection as a denial with the reason `authorization unavailable`, so a broken engine never opens access.
- Only `allowed: true` allows. A missing or non-boolean value is a deny.
- Order in the stack: local policy rules come first; only when they do not deny does this port get asked. When neither policy rules nor this port is configured, tool calls are allowed. A deployment that needs deny by default configures a catch-all deny rule or an authorization adapter.
- A deny carries a human-readable `reason` when available; it stays inside the stack and the model sees a generic denial.
- The question is built from the run: roles and scopes come from the verified caller. Callers cannot add their own claims to it.
- An unauthenticated call is never presented as the agent's own identity. The caller is the explicit anonymous caller, and engines must not match `user` or `agent` rules for it.
- Decisions are side-effect free and repeatable for the same question, except where the policy depends on time or external state.
- Approval is separate: an `ask` effect from the local policy is resolved by [ApprovalPort](ApprovalPort.md) before this port is asked.

## Errors

- Returned as a result: allow and deny, including every "not permitted" case.
- Rejects: engine unreachable, cancellation. The stack turns the first into a deny; cancellation propagates.

## Escape hatch

`ext` on the question and the decision carries engine-specific data (for example `authzen.context`); keys are namespaced and declared in the adapter descriptor's `ext.produces` / `ext.reads`. `native()` returns the policy engine client. Policy engines with their own request format (AuthZEN) translate at the adapter; how the question's fields land on that format is configurable through the stack config `mappings` block (`authorization`, `out` rules); see [Mappings](../language.md#mappings). A mapping error denies the call.

## Conformance

`checkAuthorization` verifies:

- `evaluate` of a sample tool-call question resolves to a decision that validates against `access-decision.json`.
- Every fixture question expected to be allowed gets `allowed: true`.
- Every fixture question expected to be denied gets `allowed: false`.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): `AccessQuestion {caller, action, target, args?}` replaces `AccessRequest`; `AccessDecision.allowed` (was `decision`) and `reason`; anonymous is an explicit caller
- 0.2.0 — unauthenticated calls use an explicit `anonymous` subject; `subject.properties.authenticated` added
- 0.1.0 — initial

Example adapters: `rules-authorization` (local rule list).
