# IdentityPort

Layer: `identity` (L6 Identity & access) · Version: 0.1.0 · Conformance: `checkIdentity`

## Purpose

Turn the credential a caller presents into an identity the rest of the stack can use: who is calling, with which roles and scopes. A developer plugs in an identity provider without changing channels, tools or policy.

Boundary: this port answers "who is it". "What may they do" is [AuthorizationPort](AuthorizationPort.md); outbound tokens are [CredentialPort](CredentialPort.md).

## Operations

- `verify(credential: String, opts?: {signal?: Signal}) → Identity`
  Validate an inbound credential (a token, a key) and return the identity it proves. Rejects when the credential is invalid.

## Data shapes

[Identity](../schemas/identity.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `subject` | String, required, non-empty | Stable id of the person or agent. |
| `kind` | `user` or `agent`, required | A person (the run acts on their behalf) or the agent's own identity. |
| `roles?` | [String] | Roles granted. |
| `scopes?` | [String] | Scopes granted. |
| `claims?` | {String: Any} | Additional verified claims. |
| `token?` | String | The raw inbound credential, kept so the run can exchange it. Not part of the schema. |

## Semantics

- Verification is complete: expiry, signature or lookup, audience and issuer checks belong to the adapter. A credential that cannot be proven valid is rejected, never accepted by default (fail closed).
- The identity flows to every port call in the run through `CallContext.identity`.
- The raw `token` is never written to events, logs, traces, guard inputs or telemetry attributes. Anything that serialises an identity for those uses drops `token` first (the public identity is the identity without `token`).
- Verification has no side effects on the caller beyond optional caching by the adapter.
- A stack without an identity port runs without identities; channels then have nothing to verify and treat callers as anonymous.

## Errors

- Rejects: empty, malformed, unknown, expired or revoked credential; provider unreachable; cancellation.
- Returned as a result: only a valid identity. There is no "anonymous" result.

## Escape hatch

`Identity.claims` carries provider-specific claims. `native()` returns the underlying provider client.

## Conformance

`checkIdentity` verifies:

- `verify` rejects for each invalid credential fixture (by default an empty string and an unrecognised string).
- With a valid credential fixture: `verify` resolves to an identity that, without `token`, validates against `identity.json`, and whose subject equals the expected one when given. Without a valid fixture this part is skipped.

## Version history

- 0.1.0 — initial

Example adapters: `static-identity` (maps a static token table, for development only).
