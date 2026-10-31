# Identity & access

Layer id `identity` (L6), Control plane. *Who is it, on whose behalf, and what is allowed?*

## Responsibility

Know who is calling, act with the right credentials, and decide what is allowed. An agent acts either on behalf of a
user or as its own identity.

## Ports

| Port | What it does |
|---|---|
| [IdentityPort](../../spec/ports/IdentityPort.md) | `verify` an inbound credential into an `Identity` |
| [CredentialPort](../../spec/ports/CredentialPort.md) | `token` for an outbound call, on behalf of the caller or as the agent |
| [AuthorizationPort](../../spec/ports/AuthorizationPort.md) | `evaluate` an access request into a decision |
| [ApprovalPort](../../spec/ports/ApprovalPort.md) | Human approval for actions the policy marks `ask` |

Data shapes: [identity.json](../../spec/schemas/identity.json), [access-request.json](../../spec/schemas/access-request.json),
[access-decision.json](../../spec/schemas/access-decision.json), [approval.json](../../spec/schemas/approval.json).

## Standards

- OIDC / OAuth 2: JWT access tokens verified through discovery and JWKS.
- RFC 8693 token exchange: on-behalf-of.
- Client credentials: the agent's own identity.
- OpenID AuthZEN for authorization requests.

## Boundaries

- Who may do what is identity; whether the content is acceptable is [guardrail](guardrail.md).
- Authorization is local rules first (`allow` / `ask` / `deny` by tool, risk and `when: {roles, scopes, kind}`), then
  the external decision point. A local `deny` is final, and a failing decision point denies (fail closed).
- Tokens never appear in events, logs or traces. Telemetry masks attribute keys that look like secrets.
- Every policy decision is emitted to [telemetry](telemetry.md) as an audit event.

## How to swap

- Any OIDC provider (Keycloak, Entra ID, Auth0, Zitadel, Authentik) works through the same adapter by changing the
  issuer and client; on-behalf-of needs RFC 8693 support at the token endpoint.
- Any AuthZEN-compliant decision point, or OPA, implements AuthorizationPort.
- Corporate identity is a profile change, not a code change; see [guide.md](../guide.md#from-prototype-to-production).

## Reference adapters

| Adapter | Maps |
|---|---|
| `static-identity` | A static token table (development only); IdentityPort and CredentialPort |
| `rules-authorization` | A local rule list |
| `memory-approval` | An in-process approval store |
| `oidc` | OIDC / OAuth 2.0: JWT verification, RFC 8693 token exchange, client credentials |
| `authzen` | OpenID AuthZEN access evaluation |
| `opa` | Open Policy Agent data API |

Full list: [adapters.md](../adapters.md).

## Reference setup

[`reference/identity/`](../../reference/identity/README.md) runs Keycloak (Apache-2.0, realm `agents`) and Open Policy
Agent (Apache-2.0). Keycloak listens on `KEYCLOAK_PORT` (default 8080; use 18080 when 8080 is busy and set
`OIDC_ISSUER` to match); OPA on 8181. Variables: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
`TOOLS_AUDIENCE`, `OPA_URL`.

```bash
make up LAYER=identity
make test LAYER=identity
make down LAYER=identity
```

The test gets a real token from Keycloak, exchanges it, and checks allow and deny decisions from OPA.
