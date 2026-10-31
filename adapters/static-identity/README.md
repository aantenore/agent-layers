# @agent-layers/adapter-static-identity

Maps **static token table (development only)** → **IdentityPort** and **CredentialPort** (layer `identity`). Tier: prototype.

Development only: never use with real credentials. The package registers two adapters under the same name. The
identity adapter verifies an inbound credential against a fixed table and returns the matching identity; unknown or
empty credentials are rejected with `invalid credential`. The credential adapter hands out a fixed token per downstream
audience, or a default one.

## Options

Identity adapter (`identity` slot):

| Option | Type | Default | Meaning |
|---|---|---|---|
| `tokens` | object | required | Credential → `{ subject, kind?, roles?, scopes?, claims? }`; `kind` is `user` or `agent` (default `user`) |

Credential adapter (`credentials` slot):

| Option | Type | Default | Meaning |
|---|---|---|---|
| `tokens` | object | `{}` | Audience → token |
| `default` | string | none | Token for any audience not listed in `tokens` |

```json
{
  "layers": {
    "identity": {
      "adapter": "static-identity",
      "options": { "tokens": { "dev-token": { "subject": "alice", "roles": ["staff"], "scopes": ["docs:read"] } } }
    },
    "credentials": {
      "adapter": "static-identity",
      "options": { "tokens": { "https://api.example.com": "dev-api-token" } }
    }
  }
}
```
