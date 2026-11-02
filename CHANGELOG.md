# Changelog

Every package under `packages/*` and `adapters/*` is released with the same version. See [RELEASING.md](RELEASING.md).

## 0.4.0 - unreleased

### Added

- Resume and cancel of runs ([0003](docs/decisions/0003-run-resume.md)). `Stack.resume(runId, answer, ctx?)` continues
  a run that ended `waiting`, with `{ approval: { id, approved, reason? } }` or `{ input }`, and keeps its id, session
  and caller; `Stack.cancel(runId, { by, reason })` aborts a run in flight in this process or withdraws a waiting run
  and its pending approval. When a run ends `waiting` the host keeps its input, caller (never the credential), session,
  the call that waits and the runtime's checkpoint, in the stack's store when configured, else in memory. Only the
  caller that started the run may act on it, unless the authorization port allows `decide`; an approval answer is
  always authorized like the gateway's `decide`. Refusals are `RunRefused` (`@agent-layers/core`).
- RuntimePort 1.3.0: optional `RunnableAgent.resume(checkpoint, answer, ctx)` and `RunResult.checkpoint` (also on
  `run.end`), removed by the host before a result leaves the stack. A runtime without `resume` is run again from its
  input (not deterministic with a real model). Conformance checks resume for runtimes that declare it
  ([RuntimePort](spec/ports/RuntimePort.md#resume)).
- `basic-runtime` and `reinloop` implement `resume`: the run continues from its conversation (`basic-runtime`) or its
  event log (`reinloop`), runs exactly the call that waited, adds an input answer after its result and goes on. The
  `a2a` runtime continues the remote task with a follow-up message.
- ChannelPort 1.2.0: optional `ChannelHost.resume` and `ChannelHost.cancel`. The `a2a` channel continues the run of an
  `input-required` task when a message names it (`taskId`), and CancelTask cancels the run in the stack.
- AuthorizationPort 1.3.0: core actions `resume` and `cancel`, target kind `run`.
- Gateway: `POST /runs/<id>/resume` and `POST /runs/<id>/cancel`, off unless `gateway.runs.enabled`, authenticated and
  authorized with actions `resume` and `cancel` on target kind `run` ([docs/gateway.md](docs/gateway.md#runs)).
- Limits `limits.run.resumeTtlMs` (604800000 ms) and `limits.run.maxWaitingInMemory` (1000); telemetry events
  `agent.run.resumed`, `agent.run.cancelled`, `agent.run.keep_failed`, `agent.run.control_failed`.
- Readiness warns on the production tier when an approval adapter is configured without a store.

### Changed

- `ApprovalPending` carries the arguments of the call that waits (`args`), kept by the host to resume the run and
  never written to the result.

## 0.3.0 - 2026-11-02

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
- Delegation chain and run bounds ([0002](docs/decisions/0002-delegation-bounds.md)). `Caller.actors` is the verified
  chain of agents that acted for a caller (first delegate first, the current actor last). Every run gets
  `CallContext.bounds` (deadline, token and cost budget, hop count) from `limits.run` and from what a calling agent sent
  (`CallContext.delegation`), which can only tighten them; the host refuses a run over the hop limit (new core stop
  code `hop_limit`) or with too little time, arms an abort at the deadline, and fills `usage` and `costUsd` from the
  run's ledger when the runtime reports none. The governed model refuses a call once the deadline has passed or the
  budget is spent (`BoundsExceeded`, `timeout` or `limit`) and debits each reply, priced with the new
  `pipeline.pricing`; the governed tools refuse a call after the deadline. `outboundBounds(ctx)` gives an adapter what
  to send to the next agent (time left minus a margin, hops plus one, a reservation of the budget, the lineage) and
  refuses locally over the hop limit. New limits `limits.run.timeoutMs` (300000), `limits.run.maxHops` (4),
  `limits.run.maxTokens`, `limits.run.maxCostUsd` (unbounded, a production warning), `limits.delegation.marginMs`,
  `limits.delegation.minRemainingMs` (1000) and the setting `limits.delegation.inbound` (`tighten` or `ignore`); telemetry
  `agent.run.hops`, `agent.run.max_hops`, `agent.run.deadline_ms`, `agent.run.root`, `agent.run.parent`,
  `agent.caller.actors` and the metric `agent.bounds.stops` ([docs/limits.md](docs/limits.md#limits),
  [harness](docs/layers/harness.md#run-bounds), `@agent-layers/core`).
- The A2A bounds extension ([spec/extensions/bounds-v1.md](spec/extensions/bounds-v1.md), URI
  `https://github.com/aantenore/agent-layers/blob/main/spec/extensions/bounds-v1.md`, the agent-plexus URI accepted as
  an alias). `a2a` channel: declared in the cards (`capabilities.extensions`, option `extensions`), activated by the
  `A2A-Extensions` header or `message.extensions`, data validated (`-32602` when malformed) and passed to the host;
  the task reports `usage`, `costUsd` and a bounds `stop` under the URI, next to `metadata["agent-layers"]`, which
  stays. `a2a` runtime: sends what is left of the run's bounds on every message (option `extensions`), refuses locally
  over the hop limit, settles its reservation with the remote report, and maps a remote bounds stop to its code.
- Gateway: `Agent-Bounds` and `Agent-Lineage` request headers (RFC 9651 dictionaries, bounded by
  `gateway.maxTraceChars`, 400 when malformed) become `InboundContext.delegation`; `openai-compatible` and `mcp` pass it
  to the run. MCP: `params._meta["agent-layers/bounds"]` is read on `tools/call` and sent on every outbound tool call
  (time and hops only) ([docs/gateway.md](docs/gateway.md)).
- `oidc`: the RFC 8693 `act` claim becomes `Caller.actors` (nesting reversed, at most `maxActors`, default 10; a
  malformed chain rejects the token), `may_act` is kept in `ext["oidc.may_act"]`; credentials option `actor: "self"`
  sends the stack's own token as `actor_token` on token exchange.
- Policy rules (stack `policy` and `rules-authorization`): `when.actor` (the current actor's id, globs), `when.actors`
  (any actor of the chain) and `when.delegated`. `opa` passes `input.caller.actors`; `authzen` sends
  `subject.properties.actors`.
- Conformance: `checkRuntime` checks, for RuntimePort 1.2.0, that the run's bounds reach every model and tool call and
  that a refused model call ends the run `stopped` with `limit`; `checkChannel` with a `sendBounds` fixture checks, for
  ChannelPort 1.1.0, that a caller's bounds reach the host never looser and that a run over the hop limit shows as
  stopped (`@agent-layers/conformance`).
- StorePort 1.0.0 (layer `harness`, slot `layers.store`, `stack.ports.store`): durable small JSON values by key, for
  the state a host keeps between runs. `get(key) → {value, version, expiresAt?}`, `set(key, value, {ifVersion?, ttlMs?})
  → {ok: true, version} | {ok: false, version?}` (compare-and-set: `ifVersion: 0` creates only), `delete(key,
  {ifVersion?}) → {ok: true, existed} | {ok: false, version?}`, optional `list(prefix, {limit?, after?})`. Keys are
  `<namespace>.<name>`; versions grow with every write and are never reused for a key; an expired key reads as absent.
  It sits beside StatePort: the log records what happened, the store holds what is true now. Schema
  `store-entry.json`; core helpers `storeKeyProblem`, `jsonProblem`, `encodeStoreValue`, `storeOptionsProblem`; suite
  `checkStore` ([StorePort](spec/ports/StorePort.md), [harness](docs/layers/harness.md), `@agent-layers/core`,
  `@agent-layers/conformance`).
- `memory-store` (prototype) and `sqlite-store` (prototype and production: one SQLite file, WAL, versioned schema,
  every write one `BEGIN IMMEDIATE` transaction so compare-and-set holds across processes, private folder and file
  0700/0600, expired keys pruned `retainMs` after expiry). Limits `maxKeys` (memory), `maxKeyChars`, `maxValueBytes`,
  `listLimit`, `busyTimeoutMs` and `retainMs` (sqlite) ([adapters/memory-store](adapters/memory-store/README.md),
  [adapters/sqlite-store](adapters/sqlite-store/README.md), [docs/limits.md](docs/limits.md)). On the production tier
  the readiness gate refuses `memory-store` like any prototype-only adapter; the slot stays optional.
- ApprovalPort 1.2.0: optional `list({status?, limit?})` (pending by default, oldest first, capped by the adapter's
  `listLimit`, default 100) and `cancel(id, {by?, reason?})`, which withdraws a pending approval with the new status
  `cancelled`: a waiting call is refused, a later identical call asks again (a denial still stands). `memory-approval`
  and `sqlite-approval` implement both; `sqlite-approval` adds an index by status (schema v2) and prunes cancelled
  rows after `retainMs`. `checkApproval` checks them for adapters declaring 1.2.0 (`checkAdapter` passes the
  descriptor's version) ([ApprovalPort](spec/ports/ApprovalPort.md)).
- Gateway approval routes, off unless `gateway.approvals.enabled` (`path`, default `/approvals`): `GET /approvals`
  (`?status=`, `?limit=`), `GET /approvals/<id>`, `POST /approvals/<id>` with `{ "decision": "approve" | "deny",
  "reason"? }`, `DELETE /approvals/<id>` (cancel). Every request is authenticated like any route, then authorized
  through the AuthorizationPort with action `list` (reads) or `decide` (decisions and cancels) on a target of kind
  `approval`; no authorization adapter, an error or no allowing answer refuses it (403). The verified caller is recorded
  as `decidedBy` (`kind:id`); the request key and any credential are left out of the answers. The gateway refuses to
  start with the routes enabled and no approval or authorization adapter ([docs/gateway.md](docs/gateway.md#approvals),
  `@agent-layers/gateway`).
- Policy rules (stack `policy` and `rules-authorization`): `actions`, the actions a rule matches (`call`, `decide`,
  `list`, or values added like them).
### Changed

- SDK language 1.0 → 1.1 and port minors: ModelPort, RouterPort, ToolPort, KnowledgePort, IdentityPort,
  AuthorizationPort and ChannelPort 1.1.0, RuntimePort 1.2.0 ([0002](docs/decisions/0002-delegation-bounds.md)).
  Additive for the SDK, but breaking for strict validators of the published schemas: `common.json` `PublicCaller`
  (and so `caller.json`, `access-question.json`, `guard-check.json`) gains `actors`, `common.json` gains `Actor`,
  `Bounds`, `Lineage` and `Delegation`, the stop code `hop_limit` appears in `run-result.json`, and
  `stack-config.json` gains `limits.run`, `limits.delegation`, `pipeline.pricing` and the policy conditions `actor`,
  `actors`, `delegated`. A validator pinned to the old schemas with `additionalProperties: false` rejects them.
- AuthorizationPort 1.2.0: core actions `decide` and `list` and target kind `approval`. A policy rule without
  `actions` now matches tool calls only (`call` and values added like it), so rules written for tools never open the
  approval routes; questions with an action outside the vocabulary no longer match such rules either.
  `rules-authorization` applies its `default` to tool calls only and denies any other action no rule matches. An
  engine behind `opa` or `authzen` receives the new actions; a policy there that ignores `action` answers them like
  tool calls ([AuthorizationPort](spec/ports/AuthorizationPort.md)). The `approvalStatus` vocabulary gains `cancelled`
  (`common.json`), breaking for strict validators pinned to the old enum, like the other schema additions above.
- Every run now has a deadline (`limits.run.timeoutMs`, 5 minutes by default) and a hop limit (4); a caller of kind
  `agent` counts as one hop. `basic-runtime` `maxTurns` and `reinloop` `budget` stay as extra limits.

### Fixed

- `memory-approval`: `wait` on an approval with an expiry could resolve `pending` when its timer fired a millisecond
  before the clock reached `expiresAt`; it now re-arms until the approval reads `expired`.
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
- Run bounds as added in this release ([0002](docs/decisions/0002-delegation-bounds.md),
  `@agent-layers/core`):
  - A tool call served over MCP with bounds (`_meta["agent-layers/bounds"]` or `Agent-Bounds`) now runs under them:
    the hosted tools start a ledger with the stack's limits, refuse a call over the hop limit or with too little time
    (an error result, `Stopped by the run bounds: <code>`), arm the deadline, and set `ctx.bounds`, so the hop count
    no longer resets on each MCP hop. `outboundBounds` passes on `ctx.delegation` when the context has no run of its
    own.
  - A remote run that reports no cost or usage keeps its reservation spent for the budget, but the reservation is no
    longer reported as `RunResult.costUsd` (or `usage`): the figure stays unknown (`RunLedger.usageKnown`,
    `costKnown`). The ledger takes only finite figures ≥ 0; NaN, negative or infinite usage and cost are unknown, and
    `priceOf` never returns a negative or NaN cost.
  - Under a cost budget, a reply from a model that a non-empty `pipeline.pricing` does not price emits the event
    `agent.cost.unpriced`, and stops the run (`limit`, the detail names the model) when `limits.run.maxCostUsd` is
    set, instead of silently turning the cost budget off. Prices are own entries only (`priceFor`): a model named `constructor` has none.
  - `outboundBounds` takes the margin off the adapter's time limit too: `min(time left, timeoutMs) - marginMs`.
  - A bounds stop reaches the start of a chain: the `a2a` runtime keeps the core's reason (`by: "sdk.hops"`, ...) for a
    remote bounds `stop`, so a served stack reports it upstream in turn (S1 → S2 → S3 over the hop limit reaches S1 as
    `hop_limit`).
  - A run started with the context of a run in progress (in-process nesting) is that run's delegate: hops plus one, a
    reservation of the parent's budget settled with the nested run's result, the parent as lineage, a run id of its
    own; an explicit delegation passed along still tightens.
  - `limits.delegation.inbound: "ignore"` drops the caller's lineage too.
  - A streamed model reply broken off by the consumer or failed is still debited.
  - The deadline counts as the cause of a failed or stopped run only when its own signal fired, not when the clock
    passed it; the deadline timer (`deadlineSignal`, now `{signal, clear}`) is unref'd and cleared when the run
    settles; a refused stream counts in `agent.bounds.stops`.
- `oidc` credentials: with `actor: "self"`, the refresh skew is taken off once, not twice, so short-lived exchanged
  tokens are cached.
- Policy globs match across line breaks; `when.issuer` (stack `policy`, `rules-authorization`) restricts `actor` and
  `actors` to actors vouched for by a matching `Actor.issuer`; `policySubject` fails closed on a malformed actor chain
  (the caller counts as delegated) instead of dropping malformed actors, and `rules-authorization` denies such a
  question before any rule ([AuthorizationPort](spec/ports/AuthorizationPort.md)).
- `formatAgentBounds` and `formatAgentLineage` (`@agent-layers/core`) write the `Agent-Bounds` and `Agent-Lineage`
  headers the gateway parses: integers capped at 15 digits (`SF_MAX_INTEGER`, so an unbounded max hops is accepted)
  and the cost rounded down to 3 decimals. MCP tools option `bounds: false` stops sending the run bounds in `_meta`.

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
