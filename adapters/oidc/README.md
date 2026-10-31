# @agent-layers/adapter-oidc

Maps **OpenID Connect / OAuth 2.0 (RFC 7519, RFC 8693)** → **IdentityPort** and **CredentialPort** (layer `identity`).
Tier: production. Maturity: experimental. Zero runtime dependencies (`fetch`, `node:crypto`).

Works with any OpenID provider that publishes discovery and a JWKS: Keycloak, Entra ID, Auth0, Okta, Zitadel,
Authentik, Dex. Keycloak needs no adapter of its own: [reference/identity](../../reference/identity) runs Keycloak and
OPA, and this adapter's live test (`test/live.test.ts`) runs against it.

## IdentityPort: verify inbound tokens

`verify(token)` checks a JWT access token and returns the `Caller` it proves:

- Keys from OIDC discovery (`<issuer>/.well-known/openid-configuration`, whose `issuer` must match) and the JWKS. The
  key set is cached (`jwksMaxAgeMs`), refetched on an unknown `kid` at most once per `jwksMinRefreshMs`, and the
  previous set keeps serving while the provider is down.
- Asymmetric algorithms only, from an allow-list (default `RS256`, `ES256`). `none` and `HS*` are always refused, RSA
  keys must have at least 2048 bits, EC curves must match the algorithm. Tokens with a `crit` header are refused.
- `iss` must equal `issuer`; `aud` must contain one of `audience`; `exp` is required; `nbf` and `iat` are checked, all
  with `clockSkewSec`.
- `kind` is `agent` only for a client-credentials token of a client listed in `agentClients` (its `azp`, or
  `client_id`): no `sub`, or `sub` equal to that client's entry in `agentSubjects` (when none is set, to the client id,
  as in RFC 9068). Everything else is `user`; without `agentClients` no token is ever `agent`. Usernames never count.
  A token without `sub` that is not an allow-listed agent is refused.
- `id` is `sub` (the client id for an agent token without `sub`), `credential` is the token (kept in memory only).
- Roles, scopes and name come from the claims through `in` mapping rules on `Caller`. Defaults (the descriptor's
  `mappingDefaults`, replaceable through `mappings.identity.in` in the stack config):

  | Claim | Caller | Rule |
  |---|---|---|
  | `realm_access.roles` ∪ `roles` | `roles` | `{ "from": ["/realm_access/roles", "/roles"], "to": "/roles", "join": "union" }` |
  | `scope` (space separated) | `scopes` | `{ "from": "/scope", "to": "/scopes", "split": " " }` |
  | `preferred_username` | `name` | `{ "from": "/preferred_username", "to": "/name" }` |

  Two things stay in code, whatever the rules: `resource_access` roles of the `roleClients` only (default: the
  `audience` values), named `<client>:<role>` unless `namespaceClientRoles` is false, and the `scp` claim, merged into
  the scopes. Rules may write `/ext/oidc.<name>` (for example a tenant claim); other namespaces are dropped.
- `id`, `kind` and `credential` come from verification only: a rule that writes or drops them is refused when the
  adapter is created, and a mapping function that changes them rejects the token. A failing rule, or one that leaves
  `roles` or `scopes` as something other than a list, rejects the token; the error names the rule, never its text.
  Non-string list items and a non-string name are dropped.
- `ext["oidc.exp"]` is always the verified `exp`. The verified claims are kept under `ext["oidc.claims"]` only with
  `keepClaims: true`; otherwise guards, policies and events see none.

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
| `maxKeyTries` | integer | `5` | Most keys tried for a token without `kid` |
| `maxTokenChars` | integer | `16384` | Longest token accepted |
| `maxResponseBytes` | integer | `1000000` | Largest discovery or JWKS document read |
| `errorDescriptionChars` | integer | `200` | Characters of a provider error description kept in an error message |
| `allowHttp` | boolean | `false` | Plain HTTP outside loopback hosts |
| `agentClients` | string[] | none | Clients whose client-credentials tokens are the agent |
| `agentSubjects` | {client: sub} | none | Service-account `sub` per agent client (Keycloak: the service-account user id) |
| `roleClients` | string[] | `audience` | Clients whose `resource_access` roles count; other clients are never read |
| `namespaceClientRoles` | boolean | `true` | Client roles as `<client>:<role>` |
| `keepClaims` | boolean | `false` | Keep the verified claims under `ext["oidc.claims"]` |

## CredentialPort: outbound tokens

`token(audience, { caller, scopes })` asks the token endpoint for a token for `audience`:

- `mode: "on-behalf-of"`: OAuth 2.0 Token Exchange (RFC 8693) with `caller.credential` as `subject_token`. A run
  without a caller credential gets no token: it never falls back to the agent's own identity.
- `mode: "self"`: `client_credentials`, the agent's own identity.

Tokens are cached per audience, scopes and caller credential until `refreshSkewSec` before they expire, never past
the caller's own token (the earlier of `ext["oidc.exp"]` and the credential's own `exp`), and never shared between
callers. Identical concurrent requests share one call; a caller that
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
| `maxTokenChars` | integer | `16384` | Longest token read for its expiry |
| `maxResponseBytes` | integer | `1000000` | Largest discovery or token response read |
| `errorDescriptionChars` | integer | `200` | Characters of a provider error description kept in an error message |
| `allowHttp` | boolean | `false` | Plain HTTP outside loopback hosts |

Limits accept `${env:NAME}`. `timeoutMs`, `maxTokenChars`, `maxResponseBytes` and (credentials) `maxCacheEntries` also accept
`"unbounded"`, which `agent-layers check` fails on the production tier; `jwksMinRefreshMs` and `jwksMaxAgeMs` outside their
safe range are a warning there. Ranges and checks: [docs/limits.md](../../docs/limits.md).

## Transport rules

HTTPS is required except on loopback hosts (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`) or with `allowHttp`.
URLs with embedded credentials are refused, redirects are never followed, and every response is capped at `maxResponseBytes` (1 MB).
Errors never contain tokens or the client secret; provider error descriptions are scrubbed of token-like strings.

### Migrating rules and policies

Client roles are now namespaced: a policy rule or an OPA policy that matched a client role `editor` must match
`<client>:editor` (or set `namespaceClientRoles: false` and list the client in `roleClients`). Realm roles are
unchanged. Rules on `kind: agent` need `agentClients` (and, for Keycloak, `agentSubjects`).

## Config

```json
{
  "layers": {
    "identity": {
      "adapter": "oidc",
      "options": {
        "issuer": "${env:OIDC_ISSUER}", "audience": "${env:OIDC_CLIENT_ID}",
        "agentClients": ["agent-runtime"], "agentSubjects": { "agent-runtime": "${env:AGENT_SERVICE_ACCOUNT_ID}" }
      }
    },
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
audience mapper for `tools-api`) and the test users `alice` (`analyst`) and `bob` (`viewer`). Configure
`agentClients: ["agent-runtime"]` and its service-account user id as `agentSubjects["agent-runtime"]` (admin API:
`GET /admin/realms/agents/clients/{id}/service-account-user`; the live test reads it there). For on-behalf-of,
inbound user tokens must carry the agent's client in `aud` (Keycloak: an audience mapper on the front-end client) and
the agent's client needs token exchange enabled.
