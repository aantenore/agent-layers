# AuthorizationPort

Layer: `identity` (L6 Identity & access) · Version: 1.2.0 · Conformance: `checkAuthorization`

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
| `action` | String, required | What they do. Tool calls use `call`; reading approvals `list`, deciding or cancelling one `decide` (since 1.2.0). Config may add values that behave like one of them. |
| `target` | {`kind`, `id`, `layer`, `risk`, `agent`, `attrs?`} | What it is done to. Tool calls use `kind: "tool"` and the prefixed tool name as `id`; `layer` is the tool's layer, `risk` its risk (missing risk is `exec`), `agent` the agent name, `attrs` the tool's [Attrs](README.md#language). Approvals use `kind: "approval"`, see below. |
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
- Delegation (since 1.1.0): `caller.actors` is the verified chain of agents that acted for the caller, first delegate first, the current actor last. As in RFC 8693, only the current actor counts for access control by default; the local rules match it with `when.actor`, prior actors only with `when.actors`, and `when.delegated` matches any chain or none. `when.issuer` restricts `actor` and `actors` to actors vouched for by a matching `Actor.issuer` (ids are unique per issuer only). An adapter that rebuilds the question for an engine (`policySubject`) fails closed on a malformed chain: a malformed actor stays as an actor with an empty id, so the caller counts as delegated and only `*` matches it.
- An unauthenticated call is never presented as the agent's own identity. The caller is the explicit anonymous caller, and engines must not match `user` or `agent` rules for it.
- Decisions are side-effect free and repeatable for the same question, except where the policy depends on time or external state.
- Approval is separate: an `ask` effect from the local policy is resolved by [ApprovalPort](ApprovalPort.md) before this port is asked.
- Approval questions (since 1.2.0): the gateway's approval routes ask this port before every read or decision. The target is `{kind: "approval", id: <approval id>, layer: "identity", risk: <risk of the call being approved>, agent: <its agent>, attrs: {status, tool}}` for one approval, `{kind: "approval", id: "*", layer: "identity", risk: "read", agent: "*"}` for the list, and `{kind: "approval", id: <id>, layer: "identity", risk: "exec", agent: "*"}` for an id that does not exist, so a refused caller cannot tell unknown ids from known ones. Reads use `list`, decisions and cancels `decide`. No authorization adapter, or no allowing answer, refuses the request.
- Local rules and actions (since 1.2.0): a rule with `actions` matches those actions (a core value also matches the values added like it); a rule without `actions` matches tool calls only (`call`), so rules written for tools never open approvals. `rules-authorization` applies its `default` to tool calls only and denies any other action no rule matches. An adapter that sends the question to an engine (OPA, AuthZEN) passes `action` and `target.kind` on; a policy there that does not look at `action` answers approval questions as it answers tool calls, so check `action` in it before enabling the approval routes.

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

- 1.2.0 — core actions `decide` and `list` and target kind `approval`, asked by the gateway's approval routes; policy rules match actions with `actions`, and a rule without it matches tool calls only
- 1.1.0 — `AccessQuestion.caller.actors` ([0002](../../docs/decisions/0002-delegation-bounds.md)); policy rules match the current actor (`when.actor`), any actor (`when.actors`) or delegation at all (`when.delegated`)
- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): `AccessQuestion {caller, action, target, args?}` replaces `AccessRequest`; `AccessDecision.allowed` (was `decision`) and `reason`; anonymous is an explicit caller
- 0.2.0 — unauthenticated calls use an explicit `anonymous` subject; `subject.properties.authenticated` added
- 0.1.0 — initial

Example adapters: `rules-authorization` (local rule list).
