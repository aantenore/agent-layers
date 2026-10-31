# Secrets with OpenBao

OpenBao (MPL-2.0) is the reference secret store; it is an open-source, API-compatible fork of Vault. Any store that
can hand environment variables to a container can replace it.

Locally it runs in dev mode from `../compose.yml` (`make infra-up`), is seeded with `make secrets-seed` and rendered
to a `.env` with `make env-from-openbao`; see [docs/layers/infra.md](../../../docs/layers/infra.md#secrets).
The layout below is what those scripts use.

## What goes in the store

The values marked `change-me` in `.env.example`: `OIDC_CLIENT_SECRET`, `LLM_GUARD_TOKEN`, `GATEWAY_KEY`,
`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and any provider API key.

## Suggested layout

```
secret/agents/<environment>/identity   OIDC_CLIENT_SECRET
secret/agents/<environment>/guardrails LLM_GUARD_TOKEN
secret/agents/<environment>/gateway    GATEWAY_KEY
secret/agents/<environment>/telemetry  LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY
```

One policy per layer, read-only on its own path:

```hcl
path "secret/data/agents/+/identity" {
  capabilities = ["read"]
}
```

## Delivery

Pick one:

- Render an `.env` file at deploy time (`scripts/env-from-openbao.sh`) and pass it to `docker compose --env-file`.
- Inject with OpenBao Agent templates or the Kubernetes secrets CSI provider.
- Reference secrets from reinloop config with `${env:NAME}` so the agent file never contains a value.

## Rules

- Secrets are not committed. `.env` is git-ignored.
- Tokens issued by the identity layer are short-lived and never logged, put in events or in traces.
- Rotate `change-me` defaults before exposing any service beyond localhost.
