# Changelog

Every package under `packages/*` and `adapters/*` is released with the same version. See [RELEASING.md](RELEASING.md).

## 0.3.0 - unreleased

Every package moves to 0.3.0 together: adapters of this release use core exports that 0.2.0 does not have
(`ApprovalPending`, `runEndOf`, `inboundSessionId`, `ownerDigest`, `versionAtLeast`).

### Added

- `cron-trigger`: a TriggerPort adapter that starts runs on a fixed interval (at least 1000 ms) or a five-field cron
  expression (UTC, Vixie day rule), with timers in the running process. Prototype tier; a firing is skipped while the
  previous run of its schedule is still going, a failed run is reported as the telemetry event
  `cron-trigger.run.failed`, and `start` rejects a schedule naming an agent the stack does not have. The gateway does
  not run it and says so at start-up ([adapters/cron-trigger](adapters/cron-trigger/README.md)).
- `InboundMount.exposeHeaders`: response headers a mounted channel or trigger needs a browser client to read. The
  gateway adds them to `Access-Control-Expose-Headers` next to `x-request-id` and `mcp-session-id`, which stays a
  default until the MCP channel declares it (`@agent-layers/core`, `@agent-layers/gateway`,
  [ChannelPort](spec/ports/ChannelPort.md)).
- `devCredential(options)` on an adapter descriptor: the development credential an identity adapter offers as the
  CLI's default caller on a prototype-tier profile. `static-identity` implements it with the first token of its table;
  the CLI no longer names that adapter (`@agent-layers/core`, `@agent-layers/cli`,
  `@agent-layers/adapter-static-identity`).
- `a2a` runtime: `cancelTimeoutMs` (default 5000), the time limit of the `CancelTask` sent when a run is aborted or
  times out ([docs/limits.md](docs/limits.md)).
- `adapters/_template`: a declared limit (`maxTextChars`), an `ext` key in `ext.produces`, `mappingDefaults` with the
  native result passed through `mappings.in`, and a maturity checklist in its README.
- Swap matrix cells that need no external service: `eval-layer-signals` (evaluators) and `channels-gateway`
  (the channels the gateway mounts, checked by conformance) ([docs/swap.md](docs/swap.md)).
- CI: a `checks` job on every push to `main` and every pull request: `npm ci`, build, typecheck, package tests,
  documentation checks and the swap matrix cells without needs. The existing jobs stay manual.
- `sqlite-approval`: a durable ApprovalPort on one SQLite file (`node:sqlite`, WAL, versioned schema), prototype and
  production tiers. Same semantics as `memory-approval`; `lookup` consumes atomically across processes and `wait`
  sees a decision taken by another process within `pollMs`. The folder and file it creates are private (0700, 0600);
  consumed and expired rows are pruned after `retainMs` (default 7 days). The slice's production profile uses it
  ([adapters/sqlite-approval](adapters/sqlite-approval/README.md)).
- `ApprovalPending` and `runEndOf(err)`: inside a run the stack's tools throw `ApprovalPending` for a call waiting for
  an approval, and the stack ends the run `waiting` with reason `needs_input`, whether the runtime lets the error
  through or ends the run with its stop reason. Only runtimes whose descriptor declares RuntimePort 1.1.0 or later get
  the error; a runtime built for 1.0.0 gets the pending result as before, so it cannot turn the approval into a
  failed tool call. Hosted tools (channels) keep returning the pending result.
  `basic-runtime` and `reinloop` handle it; their check of `ext["sdk.approval"]` stays for tools that return the
  result (`@agent-layers/core`, [RuntimePort](spec/ports/RuntimePort.md) 1.1.0).
- `RunResult.ext["sdk.approval"] = {id, by?, tool?}` on a run waiting for an approval: the approval id, structured,
  instead of only `reason.detail`.
- Sessions from clients, scoped to the verified caller (`inboundSessionId` in `@agent-layers/core`; none for an
  anonymous request, so anonymous clients never share sessions or approvals), so a pending approval is found again: `openai-compatible` reads the `Agent-Session` header or the `user` field (`session` option), the MCP
  server `params._meta["agent-layers/session"]` on a stateless request (`sessionMetaKey`), `cloudevents` the
  `agentsession` extension attribute (`sessionAttribute`); `TriggerSink.accept` takes `sessionId`
  ([TriggerPort](spec/ports/TriggerPort.md) 1.1.0).
- `sessions.secret` in the stack config (a `${secret:...}` reference): the owner part of a session id is an
  HMAC-SHA-256 keyed with it (`ownerDigest`, passed to channels and triggers as `ChannelHost.ownerDigest` /
  `TriggerSink.ownerDigest`), because session ids leave the process (an `a2a` runtime sends them as the context id).
  Without it the digest stays a plain hash and `agent-layers check` warns on a production-tier profile with channels
  or triggers ([docs/gateway.md](docs/gateway.md)).
- `GatewayHandle.warnings` and an `agent.config.warning` event for each configured trigger that only starts (it never
  fires under the gateway); `agent-layers gateway` prints them.
- The MCP channel declares `mcp-session-id` in its mount's `exposeHeaders`; the gateway keeps it as a default for
  channels that do not.
- Waiting runs at the edge: the MCP server adds `_meta["agent-layers/approval"] = {id}` to a tool result waiting for an
  approval; `openai-compatible` answers a run that did not complete with `x-agent-run-status`, and a waiting one with
  `x-agent-approval` (not streamed).
- `gateway.auth`: `{ "scheme": "header", "header": "X-Api-Key" }` takes the credential as the raw value of a named
  header (API keys) instead of `Authorization: Bearer` (the default) ([docs/gateway.md](docs/gateway.md)).
- Conformance: `checkRuntime` checks a pre-aborted run, stream against run, the caller on every model and tool call
  and, with a `toolInput` fixture, a pending approval, for runtimes declaring RuntimePort 1.1.0 or later (a 1.0.0
  runtime keeps the earlier checks; `checkAdapter` reads the descriptor, `conformance` the `portVersion` fixture); `checkChannel` with a `sendMount` fixture checks that the caller
  reaches the host, that `waiting` and `stopped` runs show as the fixture expects, and with `sessions` that a session
  reaches the host as one `sessionId` (`@agent-layers/conformance`).

### Fixed

- `compatibleVersion` refuses an adapter whose port minor is newer than the core's (for example a RuntimePort 1.2.0
  runtime on a 1.1.0 core): it may rely on fields this core does not have. Majors must still match; adapters built for
  an older minor still load ([spec/VERSIONING.md](spec/VERSIONING.md), `@agent-layers/core`).
- `memory-approval` and `sqlite-approval`: a `request` with a key that already has a pending, unexpired approval
  returns that one instead of creating a second, so two concurrent calls no longer leave a newer pending approval that
  `lookup` returns while a person decides the older one ([ApprovalPort](spec/ports/ApprovalPort.md)).
- `a2a` runtime: a run aborted or timed out while its remote task was still working now sends a best-effort
  `CancelTask` (`tasks/cancel` on 0.3), so the remote agent stops too. A failed or slow cancel never changes the run
  result.
- Documentation matched to the code: a cancelled run resolves to `stopped` with reason `aborted` instead of rejecting
  ([RuntimePort](spec/ports/RuntimePort.md), [port notation](spec/ports/README.md)); the state log is written by the
  host and no runtime reads it back yet, so conversation continuity is planned ([StatePort](spec/ports/StatePort.md),
  [harness](docs/layers/harness.md)); `sqlite-state` listed as a StatePort adapter; fallback and quotas are delegated
  to the model backend ([RouterPort](spec/ports/RouterPort.md)); schedules come from `cron-trigger`
  ([interface](docs/layers/interface.md)); in the README, A2A is an implemented adapter and promptfoo the reference
  eval runner with its adapter planned.

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
- Published 0.2.0 smoke: `npx @agent-layers/cli@0.2.0 init --template rag`, `npm install` from the registry,
  `agent-layers check` and the project tests passed.
- Not run yet: `guard-http`, `authz-authzen` and `knowledge-http` (no reference service), `knowledge-mcp` (needs a
  loaded Qdrant collection), `runtime-pydantic-ai` (needs the Python agent and the gateway running).

## 0.1.0 - 2026-10-31

First release: the core, the CLI, the gateway, the conformance suites and the adapters of every layer.
