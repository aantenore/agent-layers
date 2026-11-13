# {{name}}

An agent project built on agent-layers. The agent is `{{agent}}` (`agents/{{agent}}.md`); everything around it is
wired in `agent-layers.json`, one adapter per layer, per profile.

## Start

```bash
npm install
npm run check                   # config, adapters, readiness and conformance for the prototype profile
npm run dev                     # talk to the agent in the terminal, with a trace line per layer
npm test                        # the smoke dataset, offline
npm run test:live               # adds a run through the local model (or AGENT_LAYERS_LIVE=1 npm test)
npm run eval                    # evals/smoke.jsonl against {{agent}}
npm run dev -- --profile local  # same stack, real model on this machine (see .env.example)
```

Every command goes through the project's scripts (`npm run layers`, `npm run diff -- pilot production`,
`npm run gateway`, `npm run test:stack`) or through `npx @agent-layers/cli <command>`. Avoid a bare
`npx agent-layers` outside this folder or before `npm install`: the unscoped name on npm is an unrelated package.

`dev` prints on stderr every knowledge source, tool call or run that fails, whatever telemetry the profile sends to
(`--quiet` hides them).

## The eleven layers in this project

| Layer | Question it answers | prototype | pilot | production |
|---|---|---|---|---|
| L0 infra | Where does it run and how does it get there? | `compose-deploy` | same | same |
| L1 llm | Who thinks? | `mock-model` (scripted, offline) | `openai-compatible` → local server | `openai-compatible` → corporate gateway |
| L2 cache | Which model, at what cost and latency? | `static-router`, `memory-cache` | same | the model gateway routes and caches (LiteLLM + Valkey); no in-process cache |
| L3 harness | How does the agent loop run and keep state? | `{{runtime}}`, `memory-state` | same | `reinloop`, `sqlite-state` |
| L4 knowledge | What does it know? | `markdown-knowledge` on `knowledge/` | `mcp` → Qdrant (`mcp-server-qdrant`) | same |
| L5 tool | What can it do? | `functions` from `tools/convert.ts` | same | same |
| L6 identity | Who is it, on whose behalf, and what is allowed? | `static-identity`, `rules-authorization`, `memory-approval` | same | `oidc`, `opa` |
| L7 guardrail | Is this content acceptable? | `regex-guard` | same | `presidio`, `llm-guard` |
| L8 interface | Who talks to it and what starts it? | `terminal-channel`; on the gateway `openai-compatible`, `mcp`, `a2a`, `cloudevents` | same | gateway only: `openai-compatible`, `mcp`, `a2a`, `cloudevents` |
| L9 telemetry | What happened? | `console-telemetry` | `otlp` | same |
| L10 eval | Was it good, and if not, which layer failed? | `expected-eval` | same | same |

Every run has a caller. In the prototype profiles `static-identity` holds a dev token, and `dev`, `eval` and
`npm test` authenticate with it, so the allow rule of `rules-authorization` (scoped with `when.authenticated`) applies.
An anonymous call is denied in every profile. To run as another caller, pass `--token <t>` or set
`AGENT_LAYERS_TOKEN`; a token the identity adapter rejects stops the command before any run.

`npm run gateway` serves the same stack on `http://127.0.0.1:8787` for runtimes and apps in any language:
an OpenAI-compatible API at `/v1` (model `mock`, or `agent:<name>` to run an agent), the tools at `/mcp`, the agents
over A2A (`/.well-known/agent-card.json`) and CloudEvents at `/v1/events`. Every request needs
`Authorization: Bearer dev-token` (the static-identity dev token); see the gateway guide of agent-layers.

The `test` profile is prototype with telemetry written to `.agent-layers/telemetry.jsonl` and no terminal channel.
The `local` profile is prototype with a real model. Every adapter named in pilot and production is a dependency of
this project, so `npm run check -- --profile production` only reports what is genuinely missing: the services those
adapters reach (identity provider, OPA, Presidio, LLM Guard, the model gateway, Qdrant, the OTLP collector) when they
are not running. Set the secrets listed in `.env.example` (`OIDC_CLIENT_SECRET`, `SESSION_SECRET`) first: without
them the check stops at configuration validation. Production keeps session state in a SQLite file (`sqlite-state`,
single node) and has no in-process cache: the model gateway behind `openai-compatible` caches responses (LiteLLM with
Valkey).

Pilot needs, besides the local model: an OTLP collector at `OTEL_EXPORTER_OTLP_ENDPOINT`, a Qdrant server at
`QDRANT_URL`, and `uv` on the PATH (the knowledge slot starts `mcp-server-qdrant` through `uvx`, which downloads it
on first use). The pages in `knowledge/` do not reach Qdrant by themselves: load them into the `docs` collection
with the same embedding model (`sentence-transformers/all-MiniLM-L6-v2`), for example through the server's
`qdrant-store` tool. When the source or the collector is down, `npm run dev -- --profile pilot` says so on stderr
and the run goes on without passages.

Production also sets, each from an environment variable (`.env.example`): `sessions.secret`
(`SESSION_SECRET`, no default: generate one), the OIDC issuer (`OIDC_ISSUER`), the model gateway (`GATEWAY_URL`) and
`gateway.publicOrigin` (`GATEWAY_PUBLIC_ORIGIN`), which have no default either, so `check --profile production` fails
until they are set; the run budget `limits.run.maxTokens` (`RUN_MAX_TOKENS`, 200000) and
`limits.run.maxCostUsd` (`RUN_MAX_COST_USD`, 5), priced with `pipeline.pricing` for the model `default` (replace the
prices with those of your model gateway), the tool time limit of the `reinloop` runtime (`TOOL_TIMEOUT_MS`, 60000).
`gateway.publicOrigin` is advertised by the A2A agent card and must be the address
clients reach once the gateway listens on `0.0.0.0`.

## Swap a technology

Change one adapter name (and its options) in the profile that should use it. Nothing else changes: not the agent
file, not the tools, not the tests.

```json
"state": { "adapter": "sqlite-state", "options": { "path": ".agent-layers/state.db" } }
```

`npm run layers` lists every port, the adapter each slot uses, and the adapters installed for it.

## Promote a layer to production

Profiles extend each other (`prototype` → `local` → `pilot` → `production`) and list only the layers that differ.
Move one layer at a time:

1. Pick the adapter for the target system: every adapter of `@agent-layers/adapters` is installed already; one from
   another package needs `npm install` and an entry in `plugins`.
2. Set it in the next profile up, with options from environment variables (`.env.example` lists them).
3. `npm run diff -- pilot production` shows what moves; `npm run check -- --profile production` fails
   while any layer still uses a prototype-only adapter or a required layer is missing.
4. `npm run deploy -- --dry-run` shows the plan without starting anything and lists the variables it would need,
   then `npm run deploy`. `compose-deploy` starts one Compose file per layer, found in `reference/<layer>/` (or set
   in its `files` option), plus the services with an image listed in `layers.services`. This project ships no
   Compose file: until you add some, the plan says `nothing to deploy`.

Most enterprise moves are standard adapters pointed at systems you already run: the corporate identity provider
through OIDC, corporate observability through OTLP, a corporate model gateway through an OpenAI-compatible URL.
