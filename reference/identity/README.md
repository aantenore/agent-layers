# Identity reference setup

Layer page: [docs/layers/identity.md](../../docs/layers/identity.md).

Who an agent run acts as (a user, on their behalf, or the agent itself), which tools it may call, and which
credentials it carries to downstream APIs. Ports: [IdentityPort](../../spec/ports/IdentityPort.md), [CredentialPort](../../spec/ports/CredentialPort.md), [AuthorizationPort](../../spec/ports/AuthorizationPort.md).

## Standards

| Concern | Standard |
|---|---|
| Inbound authentication | OAuth 2 bearer tokens (RFC 6750), JWT access tokens (RFC 7519 / RFC 9068) verified via OpenID Connect Discovery 1.0 + JWKS (RFC 7517) |
| On behalf of a user | OAuth 2.0 Token Exchange (RFC 8693), caller token as `subject_token` |
| The agent's own identity | OAuth 2 `client_credentials` (RFC 6749 §4.4) |
| Authorization | OpenID AuthZEN Authorization API 1.0 (access evaluation); OPA data API as an adapter |

## Reference implementation

| Component | Image | License |
|---|---|---|
| Keycloak (OpenID provider, token exchange V2) | `quay.io/keycloak/keycloak:26.4.2`, `start-dev --import-realm` | Apache-2.0 |
| Open Policy Agent (PDP) | `openpolicyagent/opa:1.10.1-debug` (the `-debug` tag only adds busybox for the healthcheck) | Apache-2.0 |

| Path | Content |
|---|---|
| `compose.yml` | Keycloak on `127.0.0.1:8080`, OPA on `127.0.0.1:8181` |
| `realm/agents-realm.json` | Realm `agents` (imported at start) |
| `policies/agents.rego` | `data.agents.allow` (boolean) and `data.agents.decision` (`{allow, reason}`) over an `AccessQuestion` in SDK names (`input.caller`, `input.target`) |
| `policies/agents_test.rego` | Policy unit tests (`opa test`) |
| `test/identity.test.mjs` | Live tests against Keycloak (through the `oidc` adapter and a composed stack) and OPA (Data API, SDK names) |

Realm `agents`:

| Client / user | Purpose |
|---|---|
| `agent-runtime` | Confidential client of the runtime. Service account on (agent identity; user id fixed to `2f6d2c1e-7a4b-4c1d-9e3f-5b8a0c6d7e01`, the `sub` of its client_credentials tokens, for `agentSubjects`), standard token exchange on. Audience mapper adds `tools-api`. Secret from `OIDC_CLIENT_SECRET` (default `change-me`) |
| `tools-api` | Audience of downstream tool calls; issues no tokens |
| `agents-test` | Public client with the password grant, **for the tests only**. Audience mapper adds `agent-runtime` so its user tokens can be exchanged |
| `alice` / `alice-test-only` | Realm role `analyst` |
| `bob` / `bob-test-only` | Realm role `viewer` |

The passwords, the client secret default and the admin password default (`change-me`) are test values. Never reuse
the realm file outside local development: remove `agents-test`, set real secrets and run Keycloak in production mode.

Policy (`agents.rego`), over `input.caller.kind`, `input.caller.roles` and `input.target.risk`:

| Caller | read | write | exec |
|---|---|---|---|
| user with `viewer` | allow | deny | deny |
| user with `analyst` | allow | allow | deny |
| agent (authenticated client credentials) | allow | deny | deny |
| anonymous (`kind: "anonymous"`) or any other kind, unauthenticated runs included | deny | deny | deny |

## Adapters

| Port | Adapters | Notes |
|---|---|---|
| `IdentityPort.verify(credential)` → `Caller` | `oidc` (`identityAdapter`, `createOidcIdentity`) | `static-identity` for development |
| `CredentialPort.token(audience, { caller })` | `oidc` (`credentialAdapter`, `createOidcCredentials`; modes `on-behalf-of`, `self`) | |
| `AuthorizationPort.evaluate(AccessQuestion)` → decision | `opa`, `authzen`, `rules-authorization` | Cedar, OpenFGA, Cerbos... as your own adapter |

The `opa` adapter sends the SDK's `AccessQuestion` (`caller`, `action`, `target`), the same input `test/identity.test.mjs`
sends to the Data API, so `agents.rego` decides both alike. A run without a caller is the anonymous caller; the
credential is never sent; `args` only with `includeArgs`.

Local `policy` rules run first and take `when: { roles, scopes, kind, authenticated }` (roles and scopes any-of). A
local `deny` is final; for `allow`/`ask` the decision point is consulted; its `deny` denies, and a failing decision
point denies (fail closed). Full reference: [docs/layers/identity.md](../../docs/layers/identity.md).

```json
{
  "layers": {
    "identity":      { "adapter": "oidc", "options": { "issuer": "${env:OIDC_ISSUER}", "audience": "${env:OIDC_CLIENT_ID}" } },
    "credentials":   { "adapter": "oidc", "options": { "issuer": "${env:OIDC_ISSUER}", "clientId": "${env:OIDC_CLIENT_ID}", "clientSecret": "${env:OIDC_CLIENT_SECRET}", "mode": "on-behalf-of" } },
    "authorization": { "adapter": "opa", "options": { "url": "${env:OPA_URL}" } },
    "tools": { "api": { "adapter": "mcp", "options": { "url": "http://localhost:8090/mcp", "auth": { "audience": "${env:TOOLS_AUDIENCE}" } } } }
  },
  "policy": [{ "effect": "allow", "risk": ["write"], "when": { "authenticated": true } }]
}
```

## Swapping

- **Another OpenID provider** (Auth0, Okta, Entra ID, Zitadel, Authentik, Dex...): set `OIDC_ISSUER`; anything with
  discovery and a JWKS works for verification. On-behalf-of needs RFC 8693 support at the token endpoint; otherwise use
  `self` mode or your own `CredentialPort`. If the provider marks agent tokens differently, pass a `kind` function
  to `createOidcIdentity`.
- **Another PDP**: any AuthZEN endpoint via the `authzen` adapter (`url`); OPA-compatible servers via `opa` with a
  `path`; anything else as your own `AuthorizationPort` adapter.
- **Adapter SDK**: `checkAdapter` from `@agent-layers/conformance` runs the suite of a port against an adapter and
  returns a report with the list of failures, no test framework needed.

## Run and test

```bash
make up LAYER=identity            # waits for both healthchecks (Keycloak takes ~20-40 s)
make test LAYER=identity
docker compose -f reference/identity/compose.yml exec opa /opa test /policies -v
make down LAYER=identity
```

If host port 8080 is taken, start with `KEYCLOAK_PORT=18080` and run the tests with
`OIDC_ISSUER=http://localhost:18080/realms/agents` (Keycloak derives the issuer from the request host in dev mode).

The live tests skip with a message when Keycloak or OPA is unreachable. They check: alice's token verifies into an
Identity with role `analyst`; the on-behalf-of exchange yields a token with `aud` `tools-api`, alice's `sub` and `azp`
`agent-runtime`; `client_credentials` gives kind `agent`; OPA, asked with `AccessQuestion`s in SDK names as the `opa`
adapter sends them, allows alice and denies bob on a write tool, denies exec to both and denies the anonymous caller;
a composed stack served by `@agent-layers/gateway` (`openai-compatible` channel) answers 401 without a token and
runs as alice with hers; `checkAdapter` passes for the `oidc` identity and credential adapters. The adapter-level live
test (oidc, opa, token exchange through a composed stack) is [adapters/oidc/test/live.test.ts](../../adapters/oidc/test/live.test.ts).

## Threat notes

- Tokens (caller and exchanged) never appear in run events, stores, sinks or decision reasons; verifier errors name the
  failed check only.
- Only asymmetric algorithms are accepted (`RS256`, `ES256` by default; never `none` or `HS*`); the key type is bound
  to the algorithm; `iss`, `aud`, `exp`, `nbf`, `iat` are checked with 60 s skew.
- Set the identity adapter's `audience`: without it (and without `allowAnyAudience`) the adapter refuses to start.
- Unknown-`kid` JWKS refetches are rate limited (30 s), so forged `kid`s cannot hammer the IdP.
- Exchanged tokens are cached per caller token and never outlive it; on-behalf-of without a caller token fails
  instead of falling back to the agent identity.
- PDP outages deny by default. Tool arguments are not sent to the PDP unless `includeArgs` is set.
- Keycloak `start-dev` is HTTP with an embedded database: local development only.
