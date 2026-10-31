# agent-layers-slice

The vertical slice of agent-layers: one agent (`agents/assistant.md`), one tools module (`tools/tools.ts`) and one
knowledge folder (`knowledge/`), run unchanged on three runtimes and three profiles. Only `agent-layers.json` differs
between the cells. The results and what they prove are in [docs/slice.md](../../docs/slice.md).

It is a separate project, not a change to `examples/minimal`: minimal is what `agent-layers init` generates and stays
small, while the slice needs a write tool, two callers and one profile per runtime.

| Profile | Runtime | What it adds |
|---|---|---|
| `prototype` | `basic-runtime` | Zero infrastructure: `mock-model`, `markdown-knowledge`, `static-identity`, `rules-authorization`, `regex-guard`, `jsonl-telemetry` |
| `prototype-reinloop`, `prototype-pydantic` | `reinloop`; the Pydantic AI agent over A2A | the runtime only |
| `pilot` (and `-reinloop`, `-pydantic`) | as above | the model through the LiteLLM gateway (`SLICE_MODEL`, default group `fast`), knowledge from Qdrant over MCP, telemetry to OTLP as well |
| `production` (and `-pydantic`) | `reinloop`; Pydantic AI | OIDC identity (Keycloak) with on-behalf-of tokens, OPA, Presidio, SQLite state, loopback gateway with Host checks |
| `production-basic` | `basic-runtime` | kept to show the readiness gate refusing a prototype-only runtime |

Every cell is reached through the gateway (`agent-layers gateway --profile <name>`), over A2A at `/a2a/assistant`.
The Pydantic AI agent (`runtimes/pydantic-ai`) calls the gateway back for its model (`/v1`) and its tools and knowledge
(`/mcp`), with the shared `X-Agent-Layers-Gateway` secret set on both sides.

## Run

```bash
node --conditions=source scripts/slice.mjs                      # all tiers; starts and stops everything it needs
node --conditions=source scripts/slice.mjs --only prototype     # no Docker, no model
```

Pilot and production need Docker, `uv` and Ollama serving `lfm2.5:8b` (the LiteLLM group `fast`) and `qwen3:4b`
(group `default`, one comparison cell). With `HOSTED_MODEL` and `HOSTED_API_KEY` in the environment
(`node --env-file=.env ...`), the real-model cells use the gateway's `hosted` group instead of `fast`. The driver brings up only the reference
services a tier needs (`docker compose -f reference/<id>/compose.yml --env-file .env.example up -d --wait`), with
Keycloak on 18080, and takes them down with their volumes at the end. Results:
`.agent-layers/slice-results.json` and `.agent-layers/slice-results.md`; telemetry of each cell:
`.agent-layers/slice/<cell>.jsonl`.

Callers: `dev-alice` (analyst) and `dev-bob` (viewer) in the static profiles; `alice` and `bob` of the Keycloak test
realm in production. The passwords and secrets are the reference setups' local test values.
