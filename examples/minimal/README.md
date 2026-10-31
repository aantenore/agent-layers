# agent-layers-example-minimal

An agent project built on agent-layers. The agent is `assistant` (`agents/assistant.md`); everything around it is
wired in `agent-layers.json`, one adapter per layer, per profile.

## Start

```bash
npm install
npx agent-layers check          # config, adapters, readiness and conformance for the prototype profile
npx agent-layers dev            # talk to the agent in the terminal, with a trace line per layer
npm test                        # the smoke dataset, offline
npx agent-layers eval evals/smoke.jsonl --agent assistant
npx agent-layers dev --profile local     # same stack, real model on this machine (see .env.example)
```

## The eleven layers in this project

| Layer | Question it answers | prototype | pilot | production |
|---|---|---|---|---|
| L0 infra | Where does it run and how does it get there? | `compose-deploy` | same | same |
| L1 llm | Who thinks? | `mock-model` (scripted, offline) | `openai-compatible` → local server | `openai-compatible` → corporate gateway |
| L2 cache | Which model, at what cost and latency? | `static-router`, `memory-cache` | same | gateway routes; `valkey` cache |
| L3 harness | How does the agent loop run and keep state? | `basic-runtime`, `memory-state` | same | `reinloop`, `postgres-state` |
| L4 knowledge | What does it know? | `markdown-knowledge` on `knowledge/` | `qdrant` | same |
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

`npx agent-layers gateway` serves the same stack on `http://127.0.0.1:8787` for runtimes and apps in any language:
an OpenAI-compatible API at `/v1` (model `mock`, or `agent:<name>` to run an agent), the tools at `/mcp`, the agents
over A2A (`/.well-known/agent-card.json`) and CloudEvents at `/v1/events`. Every request needs
`Authorization: Bearer dev-token` (the static-identity dev token); see the gateway guide of agent-layers.

The `test` profile is prototype with telemetry written to `.agent-layers/telemetry.jsonl` and no terminal channel.
The `local` profile is prototype with a real model. Adapters named in pilot and production that are not installed
yet are reported as "not installed" by `agent-layers check --profile <name>`.

## Swap a technology

Change one adapter name (and its options) in the profile that should use it. Nothing else changes: not the agent
file, not the tools, not the tests.

```json
"knowledge": { "docs": { "adapter": "qdrant", "options": { "url": "${env:QDRANT_URL}", "collection": "docs" } } }
```

`npx agent-layers layers` lists every port, the adapter each slot uses, and the adapters installed for it.

## Promote a layer to production

Profiles extend each other (`prototype` → `local` → `pilot` → `production`) and list only the layers that differ.
Move one layer at a time:

1. Install the adapter for the target system, for example `npm install @agent-layers/adapter-qdrant`.
2. Set it in the next profile up, with options from environment variables (`.env.example` lists them).
3. `npx agent-layers diff pilot production` shows what moves; `npx agent-layers check --profile production` fails
   while any layer still uses a prototype-only adapter or a required layer is missing.
4. `npx agent-layers deploy --profile production`.

Most enterprise moves are standard adapters pointed at systems you already run: the corporate identity provider
through OIDC, corporate observability through OTLP, a corporate model gateway through an OpenAI-compatible URL.
