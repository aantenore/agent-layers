# IdentityPort

Layer: `identity` (L6 Identity & access) · Version: 1.0.0 · Conformance: `checkIdentity`

## Purpose

Turn the credential a caller presents into a caller the rest of the stack can use: who is calling, with which roles and scopes. A developer plugs in an identity provider without changing channels, tools or policy.

Boundary: this port answers "who is it". "What may they do" is [AuthorizationPort](AuthorizationPort.md); outbound tokens are [CredentialPort](CredentialPort.md).

## Operations

- `verify(credential: String, opts?: {signal?: Signal}) → Caller`
  Validate an inbound credential (a token, a key) and return the caller it proves. Rejects when the credential is invalid.

## Data shapes

[Caller](../schemas/caller.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | String, required, non-empty | Stable id of the person or agent. |
| `kind` | `user` or `agent`, required | A person (the run acts on their behalf) or the agent's own identity. |
| `roles` | [String], required | Roles granted. An empty list, never absent. |
| `scopes` | [String], required | Scopes granted. An empty list, never absent. |
| `name?` | String | Display name. |
| `credential?` | String | The raw inbound credential, kept so the run can exchange it. Never serialised, logged or traced. Not part of the schema. |
| `ext?` | Ext | Provider-specific data. |

Raw token claims are not part of `Caller`. An adapter keeps them only when configured to, under `ext["oidc.claims"]` (for the OIDC adapter).

## Semantics

- Verification is complete: expiry, signature or lookup, audience and issuer checks belong to the adapter. A credential that cannot be proven valid is rejected, never accepted by default (fail closed).
- The caller flows to every port call in the run through `CallContext.caller`.
- The `credential` is never written to events, logs, traces, guard checks or telemetry attributes. Anything that serialises a caller for those uses the public caller, which is the caller without `credential`.
- Verification has no side effects on the caller beyond optional caching by the adapter.
- A stack without an identity port runs without callers; channels then have nothing to verify and treat requests as anonymous. Anonymous is explicit (see [AuthorizationPort](AuthorizationPort.md)); it is never the agent.

## Errors

- Rejects: empty, malformed, unknown, expired or revoked credential; provider unreachable; cancellation.
- Returned as a result: only a valid caller. There is no "anonymous" result.

## Escape hatch

`Caller.ext` carries provider-specific data (`oidc.tenant`, `oidc.claims`); keys are namespaced and declared in the adapter descriptor's `ext.produces` / `ext.reads`. `native()` returns the underlying provider client. How a provider's claims become `roles`, `scopes` and `name` is configurable through the stack config `mappings` block (`identity`, `in` rules); see [Mappings](../language.md#mappings). A mapping error rejects the credential.

## Conformance

`checkIdentity` verifies:

- `verify` rejects for each invalid credential fixture (by default an empty string and an unrecognised string).
- With a valid credential fixture: `verify` resolves to a caller that, without `credential`, validates against `caller.json`, and whose `id` equals the expected one when given. Without a valid fixture this part is skipped.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): `verify` returns a `Caller` (`id`, `kind`, `roles`, `scopes`, `name?`, `credential?`); `roles` and `scopes` are always lists; claims only through `ext["oidc.claims"]`
- 0.1.0 — initial

Example adapters: `static-identity` (maps a static token table, for development only).
