# L5 Identity & access

## Responsibility

Know who is calling, act with the right credentials, and decide what is allowed. An agent acts either on behalf of a
user or as its own identity.

## Standard

- OIDC / OAuth 2: JWT access tokens verified through discovery and JWKS.
- RFC 8693 token exchange: on-behalf-of.
- Client credentials: the agent's own identity.
- OpenID AuthZEN for authorization requests.

## Extension point

- `IdentityVerifier`: token in, `Identity { subject, kind, roles, scopes, claims }` out.
- `CredentialProvider.token(audience)`: token for an outbound call.
- `Authorizer`: decision for a tool call.

## Reference implementation

| Role | Reference | License |
|---|---|---|
| IdP | Keycloak (realm `agents`) | Apache-2.0 |
| Policy | Open Policy Agent | Apache-2.0 |

## Adapter SDK + conformance

Authorizer adapters (`opa`, `authzen`) ship with the runtime. A new policy decision point implements `Authorizer`; a
conformance check sends allow and deny cases and verifies the decision and the fail-closed behaviour when the PDP is
down. Identity itself needs no SDK: OIDC and OAuth 2 are the standard.

## Around the layer

- **Automatic token forwarding.** When a tool or knowledge source declares an audience, the runtime obtains a token
  from `CredentialProvider` and attaches it to the MCP or HTTP call. Agents and prompts never see it.
- **Never logged.** Tokens do not appear in events, logs or traces.
- **Audit.** Every policy decision is emitted to [L8](L8-telemetry.md) (`agent.policy.decisions`).

## How to swap it

- Any OIDC provider (Auth0, Zitadel, Entra ID, Authentik) replaces Keycloak: set `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET`. The provider must support token exchange if you use `on-behalf-of`.
- Any AuthZEN-compliant PDP replaces OPA through the `authzen` adapter; OPA itself uses the `opa` adapter.

## Contract

- Inbound `Authorization: Bearer <JWT>` becomes an `Identity`.
- Outbound token modes: `on-behalf-of` (RFC 8693, caller's token as `subject_token`) and `self` (`client_credentials`).
- Authorization is local rules first (`allow` / `ask` / `deny` by tool, risk, `when: {roles, scopes, kind}`), then
  the external `Authorizer`.
- AuthZEN `POST /access/v1/evaluation` and OPA `POST {OPA_URL}/v1/data/agents/allow` share one `AccessRequest`.

Schemas: [access-request.json](../../contracts/access-request.json),
[access-decision.json](../../contracts/access-decision.json). Details in
[contracts.md](../contracts.md#l5-identity-and-access).

## How to test

```bash
make up LAYER=l5-identity
make test LAYER=l5-identity
make down LAYER=l5-identity
```

Variables: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `TOOLS_AUDIENCE`, `OPA_URL`. The test gets a real
token from Keycloak, exchanges it, and checks allow and deny decisions from OPA.
