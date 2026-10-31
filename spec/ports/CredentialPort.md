# CredentialPort

Layer: `identity` (L6 Identity & access) · Version: 1.0.0 · Conformance: `checkCredentials`

## Purpose

Give tools and remote tool servers the outbound tokens they need to call protected services, either on behalf of the user who started the run or as the agent itself. Tools never hold long-lived secrets; they ask for a token for an audience when they need one.

## Operations

- `token(audience: String, opts?: {caller?: Caller, scopes?: [String], signal?: Signal}) → String`
  Return a token valid for `audience`. With `caller` the token acts on behalf of that caller; without it the token is the agent's own.
- `requiresCaller?: Boolean`
  Optional, read-only. `true` when the adapter issues tokens only on behalf of a caller (for example a token exchange): `token` then rejects unless `caller` carries the caller's inbound `credential`. Tools such as `agent-layers check` read it to know that a probe needs a caller.

## Data shapes

- `audience` is the opaque name of the downstream service the token is for. It is the `audience` field of a [ToolSpec](../schemas/tool-spec.json) when the tool declares one.
- `scopes` narrows the token to the permissions the call needs.
- `caller` is a [Caller](../schemas/caller.json); its inbound `credential`, if present, may be exchanged for the outbound token.
- The result is a non-empty string.

## Semantics

- Tokens are never logged, traced, placed in events, in tool results or in telemetry attributes. Attributes with secret-looking keys are masked by the stack, but adapters must not rely on that.
- The stack binds the port to the caller before a tool runs: the tool receives `ctx.credentials.token(audience, scopes?)`, which calls this port with the run's caller and cancellation signal already filled in. A tool cannot ask for a token on behalf of someone else.
- A token is requested per call and may be cached by the adapter until shortly before it expires; the adapter must not hand one caller's token to another.
- Least privilege: request the smallest `scopes` that do the job.

## Errors

- Rejects: the caller may not obtain a token for the audience, the provider is unreachable, the exchange is refused, cancellation. The tool then fails and the failure is returned to the model as an error result (`ok: false`).
- Never returns an empty string as a "no token" result.

## Escape hatch

The port returns a plain string, so there is no shape to extend. `Caller.ext` keys an adapter reads (for example a tenant) are declared in the descriptor's `ext.reads`, and the adapter writes only keys it declares in `ext.produces`. `native()` returns the underlying token client.

## Conformance

`checkCredentials` verifies:

- `token` for an audience (a default one when none is given) resolves to a non-empty string, on behalf of the `caller` fixture when one is given.
- With `requiresCaller`: `token` without a caller rejects (no fallback to the agent's own identity), and the probe that needs a caller is skipped, not failed, when no caller fixture with a credential is given.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): `token(audience, {caller, scopes})` (was `identity`); `caller.credential` (was `token`)
- 0.2.0 — optional `requiresCaller`, so a probe can tell an on-behalf-of adapter from a broken one
- 0.1.0 — initial

Example adapters: `static-identity` (also implements this port, for development only).
