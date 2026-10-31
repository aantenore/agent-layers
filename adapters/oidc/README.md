# @agent-layers/adapter-oidc

Maps **OpenID Connect / OAuth 2.0 (RFC 7519, RFC 8693)** → **IdentityPort** and **CredentialPort** (layer `identity`).
Tier: production. Maturity: experimental. Zero runtime dependencies (`fetch`, `node:crypto`).

Works with any OpenID provider that publishes discovery and a JWKS: Keycloak, Entra ID, Auth0, Okta, Zitadel,
Authentik, Dex. Keycloak needs no adapter of its own: [reference/identity](../../reference/identity) runs Keycloak and
OPA, and this adapter's live test (`test/live.test.ts`) runs against it.

## IdentityPort: verify inbound tokens

`verify(token)` checks a JWT access token and returns the identity it proves:

- Keys from OIDC discovery (`<issuer>/.well-known/openid-configuration`, whose `issuer` must match) and the JWKS. The
  key set is cached (`jwksMaxAgeMs`), refetched on an unknown `kid` at most once per `jwksMinRefreshMs`, and the
  previous set keeps serving while the provider is down.
- Asymmetric algorithms only, from an allow-list (default `RS256`, `ES256`). `none` and `HS*` are always refused, RSA
  keys must have at least 2048 bits, EC curves must match the algorithm. Tokens with a `crit` header are refused.
- `iss` must equal `issuer`; `aud` must contain one of `audience`; `exp` is required; `nbf` and `iat` are checked, all
  with `clockSkewSec`.
- `kind` is `agent` for client-credentials tokens (`sub` equals `client_id` / `azp`, no `sub`, or the Keycloak
  service-account user of `azp`), otherwise `user`. Roles come from `realm_access`, `resource_access` and `roles`;
  scopes from `scope` and `scp`. `claims` holds the verified payload.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `issuer` | string | required | Expected `iss`, also the discovery base URL |
| `audience` | string or string[] | required | Accepted `aud` values |
| `allowAnyAudience` | boolean | `false` | Accept any audience instead (not recommended) |
| `jwksUri` | string | from discovery | Key set URL |
| `algorithms` | string[] | `["RS256","ES256"]` | Also `RS384/512`, `PS256/384/512`, `ES384/512`, `EdDSA` |
| `types` | string[] | any | Accepted `typ` headers, e.g. `["at+jwt"]` (RFC 9068) |
| `clockSkewSec` | integer | `60` | Tolerance for time claims |
| `maxTokenAgeSec` | integer | off | Refuse tokens issued longer ago (`iat` then required) |
| `jwksMinRefreshMs` | integer | `30000` | Minimum interval between key fetches after an unknown `kid` or a failure |
| `jwksMaxAgeMs` | integer | `600000` | Key set cache lifetime |
| `timeoutMs` | integer | `5000` | Discovery and JWKS request timeout |
| `allowHttp` | boolean | `false` | Plain HTTP outside loopback hosts |
| `roleClients` | string[] | all | Clients whose `resource_access` roles count |

## CredentialPort: outbound tokens

`token(audience, { identity, scopes })` asks the token endpoint for a token for `audience`:

- `mode: "on-behalf-of"`: OAuth 2.0 Token Exchange (RFC 8693) with the caller's token as `subject_token`. A run
  without a caller token gets no token: it never falls back to the agent's own identity.
- `mode: "self"`: `client_credentials`, the agent's own identity.

Tokens are cached per audience, scopes and caller token until `refreshSkewSec` before they expire, never past the
caller's own token, and never shared between callers. Identical concurrent requests share one call; a caller that
cancels does not cancel the others.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `issuer` / `tokenEndpoint` | string | one required | Discovery base URL, or the token endpoint itself |
| `clientId`, `clientSecret` | string | required | Confidential client of the agent; the secret from `${env:...}` or, with a secrets layer, `${secret:...}` |
| `mode` | `on-behalf-of` / `self` | required | See above |
| `authMethod` | `client_secret_basic` / `client_secret_post` | basic | Client authentication |
| `audienceParam` | `audience` / `resource` / `none` | `audience` | How the audience is sent (RFC 8693 or RFC 8707) |
| `refreshSkewSec` | integer | `30` | Renew this long before expiry |
| `defaultTtlSec` | integer | `60` | Lifetime when the response has no `expires_in` and the token is not a JWT |
| `maxCacheEntries` | integer | `1000` | Cache size |
| `timeoutMs` | integer | `10000` | Token request timeout |
| `allowHttp` | boolean | `false` | Plain HTTP outside loopback hosts |

## Transport rules

HTTPS is required except on loopback hosts (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`) or with `allowHttp`.
URLs with embedded credentials are refused, redirects are never followed, and every response is capped at 1 MB.
Errors never contain tokens or the client secret; provider error descriptions are scrubbed of token-like strings.

## Config

```json
{
  "layers": {
    "identity": { "adapter": "oidc", "options": { "issuer": "${env:OIDC_ISSUER}", "audience": "${env:OIDC_CLIENT_ID}" } },
    "credentials": {
      "adapter": "oidc",
      "options": { "issuer": "${env:OIDC_ISSUER}", "clientId": "${env:OIDC_CLIENT_ID}", "clientSecret": "${env:OIDC_CLIENT_SECRET}", "mode": "on-behalf-of" }
    }
  }
}
```

## Keycloak (reference/identity)

```bash
KEYCLOAK_PORT=18080 docker compose -f reference/identity/compose.yml --env-file .env.example up -d --wait
OIDC_ISSUER=http://localhost:18080/realms/agents npm test -w @agent-layers/adapter-oidc
docker compose -f reference/identity/compose.yml --env-file .env.example down -v
```

The realm `agents` has the confidential client `agent-runtime` (service account and standard token exchange on, an
audience mapper for `tools-api`) and the test users `alice` (`analyst`) and `bob` (`viewer`). For on-behalf-of,
inbound user tokens must carry the agent's client in `aud` (Keycloak: an audience mapper on the front-end client) and
the agent's client needs token exchange enabled.
