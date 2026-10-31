# CredentialPort

Layer: `identity` (L6 Identity & access) · Version: 0.1.0 · Conformance: `checkCredentials`

## Purpose

Give tools and remote tool servers the outbound tokens they need to call protected services, either on behalf of the user who started the run or as the agent itself. Tools never hold long-lived secrets; they ask for a token for an audience when they need one.

## Operations

- `token(audience: String, opts?: {identity?: Identity, scopes?: [String], signal?: Signal}) → String`
  Return a token valid for `audience`. With `identity` the token acts on behalf of that identity; without it the token is the agent's own.

## Data shapes

- `audience` is the opaque name of the downstream service the token is for. It is the `audience` field of a [ToolSpec](../schemas/tool-spec.json) when the tool declares one.
- `scopes` narrows the token to the permissions the call needs.
- `identity` is an [Identity](../schemas/identity.json); its inbound `token`, if present, may be exchanged for the outbound token.
- The result is a non-empty string.

## Semantics

- Tokens are never logged, traced, placed in events, in tool output or in telemetry attributes. Attributes with secret-looking keys are masked by the stack, but adapters must not rely on that.
- The stack binds the port to the caller before a tool runs: the tool receives `ctx.credentials.token(audience, scopes?)`, which calls this port with the run's identity and cancellation signal already filled in. A tool cannot ask for a token on behalf of someone else.
- A token is requested per call and may be cached by the adapter until shortly before it expires; the adapter must not hand one caller's token to another.
- Least privilege: request the smallest `scopes` that do the job.

## Errors

- Rejects: the identity may not obtain a token for the audience, the provider is unreachable, the exchange is refused, cancellation. The tool then fails and the failure is returned to the model as an error result.
- Never returns an empty string as a "no token" result.

## Escape hatch

`native()` returns the underlying token client.

## Conformance

`checkCredentials` verifies:

- `token` for an audience (a default one when none is given) resolves to a non-empty string.

## Version history

- 0.1.0 — initial

Example adapters: `static-identity` (also implements this port, for development only).
