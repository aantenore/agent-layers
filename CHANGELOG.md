# Changelog

Every package under `packages/*` and `adapters/*` is released with the same version. See [RELEASING.md](RELEASING.md).

## 0.2.0 - 2026-11-01

### Added

- `agent.adapter` on every core span: the configured adapter that served it (`reinloop` on `agent.run`, `rule-router`
  on `agent.router.select`, the source's adapter on `agent.knowledge.search` and `agent.tool.call`, the guard's on
  `agent.guard.check`). The stack sets it from the configuration, so a swapped layer shows in the trace without any
  adapter change (`@agent-layers/core`, [TelemetryPort](spec/ports/TelemetryPort.md)).
- Layer swap matrix: `node scripts/swap-matrix.mjs` replaces one layer of `examples/minimal` at a time through
  configuration only, then runs `check` and `eval` and looks for the replacement in the run
  ([docs/swap.md](docs/swap.md)).
- Resumable publishing: `node scripts/publish-unpublished.mjs` publishes only the versions missing from the registry,
  used by `npm run release` and the release workflow.
- `reference/cache`: optional `HOSTED_HEADER_NAME` / `HOSTED_HEADER_VALUE` for one extra request header the hosted
  model group may need (for example the workspace a key belongs to).

### Fixed

- `agent-layers check` no longer fails a sound setup when no tool or adapter declares an audience: the credentials
  probe used a made-up audience that a real provider refuses, so `check --profile production` failed on a fresh
  `init` project. The probe is now skipped with the reason (`@agent-layers/cli`).
- `init` template: the `production` profile sends `LLM_GUARD_TOKEN` to LLM Guard and `.env.example` lists it.
  Without it the reference API refuses every scan and the guard, failing closed, blocked every request
  (`@agent-layers/cli`).
- Guard conformance failures include the verdict reason (for example `llm-guard unavailable: authentication failed
  (HTTP 401)`) instead of only the action (`@agent-layers/conformance`).

### Verified

- Release checks: clean build of the 40 packages in dependency order, typecheck, package tests (859 passed, 0 failed)
  and documentation checks.
- Published 0.1.0 smoke: `npx @agent-layers/cli init --template rag`, `npm install` from the registry,
  `agent-layers check` and the project tests (scripted model and local model) passed.
- Swap matrix, 14 cells passed (`check` and `eval` green, the replacement observed in the run where it emits a span):
  - local: state `memory-state` → `sqlite-state`; router `static-router` → `rule-router`; cache removed; runtime
    `basic-runtime` → `reinloop`; approval removed; guards removed; `regex-guard` blocking instead of redacting;
    telemetry `jsonl-telemetry` → `console-telemetry`;
  - reference services: guard → `presidio`, guard → `llm-guard`, authorization → `opa`, identity and credentials →
    `oidc` (Keycloak, real caller token), telemetry → `otlp` (collector and Jaeger);
  - real model: model → `openai-compatible` through the model gateway's `hosted` group.
- Not run yet: `guard-http`, `authz-authzen` and `knowledge-http` (no reference service), `knowledge-mcp` (needs a
  loaded Qdrant collection), `runtime-pydantic-ai` (needs the Python agent and the gateway running).

## 0.1.0 - 2026-10-31

First release: the core, the CLI, the gateway, the conformance suites and the adapters of every layer.
