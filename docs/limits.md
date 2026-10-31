# Limits

Every timeout, size cap, count, TTL and truncation length of the stack is a setting with a default. The defaults are
the values the code used before they became settings, so nothing changes until you set one. This page lists them all,
per component: where to set each one, what it accepts, the range that is safe for production, and what
`agent-layers check` does with it.

## How limits work

- **Where.** Stack-wide limits live in the stack config: `gateway`, `pipeline` and `limits`. Adapter limits are
  options of the adapter entry in its slot (`layers.<slot>.options`, or `layers.<slot>.<name>.options` for keyed
  slots). Profiles override them like any other value: objects merge deeply, `null` restores the default.
- **Environment.** A limit may be a whole-string `${env:NAME}` or `${env:NAME:-default}` reference. After
  interpolation the string must be a number in the accepted range, or the config is rejected.
- **Unbounded.** Leaving a limit out never removes it. Where it makes sense, the string `"unbounded"` turns a limit off
  explicitly; the Accepted column says where.
- **Validation.** Values outside the Accepted range (zero or negative where that means nothing) are rejected when the
  config is parsed or the adapter is created.
- **Readiness gate.** On a production-tier profile, `agent-layers check` prints `FAIL` for a limit marked
  `fail if unbounded` that is set to `"unbounded"` (unbounded request bodies or responses, disabled timeouts,
  unlimited sessions or tasks), and `WARN` for `warn if unbounded` and for values outside the safe range. A `FAIL`
  fails the check, and `agent-layers gateway` refuses to start the profile; warnings do not. Other tiers get no
  findings.
- **Declared once.** Each component declares its limits in one `LIMITS` list (`STACK_LIMITS` in
  `packages/core`, `limits` on each adapter descriptor, `LIMITS` in the Python runtime's `settings.py`). Validation,
  the readiness gate and `npm run docs:check` read that list, so this page cannot drift from the code.

```json
{
  "gateway": { "maxBodyBytes": "${env:GATEWAY_MAX_BODY_BYTES:-1048576}", "requestTimeoutMs": 120000 },
  "layers": {
    "tools": { "crm": { "adapter": "http-tools", "options": { "timeoutMs": 10000, "maxResultChars": 8000, "tools": {} } } }
  },
  "profiles": { "production": { "tier": "production", "gateway": { "headersTimeoutMs": 10000 } } }
}
```

Columns: **Setting** is the config path (for adapters, relative to the adapter entry; for the Python runtime, the
environment variable). **Default** applies when the setting is absent; `—` means it falls back to another setting,
described in Why. **Accepted** is the validated range. **Safe range** is what production should stay within.
**On production** is the readiness gate behaviour described above.

## Stack config

### `gateway`

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `gateway.maxBodyBytes` | `1048576` bytes | 1–∞ or unbounded | 1–16777216 | fail if unbounded; warn outside safe range | Largest request body; larger ones get 413 before any route reads them, so a client cannot exhaust memory. |
| `gateway.requestTimeoutMs` | `300000` ms | 1–∞ or unbounded | 1–900000 | fail if unbounded; warn outside safe range | Time limit of one request, streams included; a stuck route answers 504 instead of holding the connection. |
| `gateway.headersTimeoutMs` | `30000` ms | 1–∞ or unbounded | 1–60000 | fail if unbounded; warn outside safe range | Time a client has to send the headers; closes slow-header connections. |
| `gateway.bodyTimeoutMs` | `120000` ms | 1–∞ or unbounded | 1–300000 | fail if unbounded; warn outside safe range | Time a client has to send the whole request (capped by `requestTimeoutMs`); closes slow-body connections. |
| `gateway.closeGraceMs` | `10000` ms | 0–3600000 | — | — | How long shutdown waits for requests and trigger runs in flight before closing connections. |
| `gateway.corsMaxAgeS` | `600` s | 0–86400 | — | — | How long a browser may cache a CORS preflight answer. |
| `gateway.maxRequestIdChars` | `64` chars | 1–256 | — | — | Longest `X-Request-Id` kept from the caller; longer ones are replaced, so logs stay small. |
| `gateway.maxTraceChars` | `512` chars | 1–8192 | — | — | Longest `traceparent` and `tracestate` copied into a run, each; longer or non-printable ones are dropped, so a caller cannot grow every span and outbound header. |

### `pipeline`

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `pipeline.knowledge.k` | `4` | 1–∞ | 1–20 | warn outside safe range | Passages injected per model call, and the default k of the knowledge search tools. |
| `pipeline.knowledge.maxChars` | `4000` chars | 200–∞ | 200–32000 | warn outside safe range | Size of the injected knowledge block, so retrieval cannot crowd out the conversation. |
| `pipeline.knowledge.maxK` | `20` | 1–1000 | — | — | Largest k a model may ask the knowledge search tools for; larger requests are capped. |
| `pipeline.knowledge.fusion.rrfK` | `60` | 1–1000 | — | — | Rank constant of reciprocal rank fusion across knowledge sources; a higher value flattens the difference between ranks. |
| `pipeline.knowledge.fusion.weights.*` | `1` | 0–100 | — | — | Weight of one knowledge source (by source name) in the fusion; 0 keeps its passages out of the ranking, a higher value favours the source. |
| `pipeline.cacheTtlMs` | — | 0–∞ | — | — | Lifetime of cached model answers; when unset (or 0) the cache adapter's own TTL applies. |
| `pipeline.approvalTimeoutMs` | `0` ms | 0–∞ | 0–3600000 | warn outside safe range | How long a tool call waits for a human approval; 0 does not wait, so the call is refused while pending. |

`pipeline.cacheScope` is a setting next to these limits, not a number: `"caller"` (default) keys cached model answers
by caller id, so an answer built from one caller's knowledge is never served to another; `"shared"` keeps one entry
for every caller. On a production profile with knowledge sources and a cache, `agent-layers check` prints `WARN` for
`"shared"`; it does not fail the check. See [cache](layers/cache.md#boundaries).

### `limits`

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `limits.check.timeoutMs` | `30000` ms | 1–∞ | — | — | Time limit of one conformance probe of `agent-layers check`. |
| `limits.check.deployTimeoutMs` | `300000` ms | 1–∞ | — | — | Time limit of the deploy probes, which start and stop services. |
| `limits.check.listToolsTimeoutMs` | `5000` ms | 1–∞ | — | — | Time limit of listing tools while looking for an audience for the credentials probe. |
| `limits.extBytes` | `16384` bytes | 256–1048576 | 256–65536 | warn outside safe range | Largest `ext` bag the core keeps on a shape it passes on; a larger one is dropped and an `agent.ext.dropped` event is emitted, so adapters cannot smuggle bulk data through the extension bags. |

## Adapters

Ordered by layer. Set them under the adapter's `options`; an adapter not listed here has no limits.

### `compose-deploy` · DeployPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.healthIntervalS` | `5` s | 1–3600 | 1–60 | warn outside safe range | Sets how often a generated service is health checked. |
| `options.healthTimeoutS` | `3` s | 1–3600 | 1–30 | warn outside safe range | Bounds one health check of a generated service. |
| `options.healthRetries` | `12` | 1–1000 | 1–60 | warn outside safe range | Sets how many failed checks mark a generated service as unhealthy. |
| `options.errorOutputChars` | `500` chars | 0–100000 | 0–2000 | warn outside safe range | Limits how much Compose output ends up in the error message. |
| `options.commandTimeoutMs` | `600000` ms | 1000–∞ or unbounded | 1000–3600000 | warn if unbounded; warn outside safe range | Bounds one Compose command (`up`, `down`), so a stuck pull or start cannot hang the deploy. |

### `mock-model` · ModelPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.latencyMs` | `0` ms | 0–∞ | — | — | Adds a delay before each answer, to simulate a slow model. |
| `options.toolResultChars` | `500` chars | 0–1000000 | 0–10000 | warn outside safe range | Limits how much of a tool result the mock repeats as its answer. |

### `openai-compatible` · ModelPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.timeoutMs` | `120000` ms | 1–∞ or unbounded | 1–600000 | fail if unbounded; warn outside safe range | Bounds one request, streams included, so a slow backend cannot hold a run. |
| `options.errorBodyChars` | `300` chars | 0–100000 | 0–2000 | warn outside safe range | Limits how much of an upstream error body ends up in logs and errors. |
| `options.streamEventChars` | `100` chars | 0–100000 | 0–2000 | warn outside safe range | Limits how much of a malformed stream event ends up in the error. |
| `options.maxEventChars` | `1048576` chars | 1–∞ or unbounded | 1–16777216 | fail if unbounded; warn outside safe range | Bounds one stream event, and a line still waiting for its end, so a backend cannot grow the stream buffer without bound. |

### `memory-cache` · CachePort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.maxEntries` | `1000` | 1–∞ or unbounded | 1–100000 | fail if unbounded; warn outside safe range | Caps the entries held in memory before the least recently used one is dropped. |
| `options.ttlMs` | `unbounded` | 1–∞ or unbounded | — | warn if unbounded | Sets how long an entry lives when the caller gives no time to live. |

### `a2a` · RuntimePort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.timeoutMs` | `300000` ms | 1–∞ or unbounded | 1–3600000 | fail if unbounded; warn outside safe range | Bounds a whole run, polling included, so a stuck remote agent cannot hold it. |
| `options.pollMs` | `500` ms | 10–∞ | 100–10000 | warn outside safe range | Sets how often a working task is checked, so the remote agent is not hammered. |

### `basic-runtime` · RuntimePort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.maxTurns` | `8` | 1–100 | 1–25 | warn outside safe range | Stops an agent that keeps calling tools from looping and spending without end. |

### `reinloop` · RuntimePort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.budget.maxTurns` | — | 1–∞ or unbounded | 1–100 | fail if unbounded; warn outside safe range | Stops an agent that keeps calling the model without finishing; reinloop applies 50 when `budget` is absent. |
| `options.budget.maxToolCalls` | — | 1–∞ or unbounded | — | warn if unbounded | Caps the tool calls of one run. |
| `options.budget.maxInputTokens` | — | 1–∞ or unbounded | — | warn if unbounded | Caps the prompt tokens a run may spend. |
| `options.budget.maxOutputTokens` | — | 1–∞ or unbounded | — | warn if unbounded | Caps the completion tokens a run may spend. |
| `options.budget.maxTotalTokens` | — | 1–∞ or unbounded | — | warn if unbounded | Caps the prompt and completion tokens of one run together. |
| `options.budget.maxCostUsd` | — | 0–∞ or unbounded | — | warn if unbounded | Stops a run once its priced cost reaches the amount. |
| `options.budget.maxDurationMs` | — | 1–∞ or unbounded | — | warn if unbounded | Stops a run that takes too long overall. |
| `options.compaction.thresholdTokens` | — | 1–∞ | — | — | Context size from which older messages are dropped or summarized. |
| `options.compaction.keepFirst` | `1` | 0–∞ | — | — | Messages at the start of the conversation that compaction keeps (window strategy). |
| `options.compaction.keepLast` | — | 1–∞ | — | — | Recent messages that compaction always keeps. |
| `options.compaction.maxTokens` | `2048` tokens | 1–∞ | 1–16384 | warn outside safe range | Caps the summary a summarize compaction asks the model for. |
| `options.tools.concurrency` | `8` | 1–∞ | 1–64 | warn outside safe range | Limits how many tool calls of one batch run at the same time. |
| `options.tools.timeoutMs` | `unbounded` | 1–∞ or unbounded | 1–300000 | warn if unbounded; warn outside safe range | Bounds one tool call, so a stuck tool cannot hold the run. |
| `options.tools.maxResultChars` | `32000` chars | 1–∞ or unbounded | 1–200000 | fail if unbounded; warn outside safe range | Truncates a large tool result before the model sees it. |

### `memory-state` · StatePort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.maxSessions` | `1000` | 1–∞ or unbounded | 1–100000 | warn if unbounded; warn outside safe range | Caps the sessions held in memory; the least recently appended one is evicted first. |
| `options.maxEventsPerSession` | `10000` | 1–∞ or unbounded | 1–1000000 | warn if unbounded; warn outside safe range | Keeps only the most recent events of a session, so a long conversation cannot fill the process memory. |

### `sqlite-state` · StatePort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.busyTimeoutMs` | `5000` ms | 0–∞ or unbounded | 0–60000 | fail if unbounded; warn outside safe range | Bounds how long a write waits for a lock held by another process. |

### `http-knowledge` · KnowledgePort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.timeoutMs` | `10000` ms | 1–∞ or unbounded | 1–120000 | fail if unbounded; warn outside safe range | Bounds one query, so a slow service cannot hold a run. |
| `options.k` | `4` | 1–∞ | 1–50 | warn outside safe range | Passages asked for when the query sets no k. |
| `options.errorBodyChars` | `300` chars | 0–100000 | 0–2000 | warn outside safe range | Keeps error messages short; the body is masked before it is cut. |
| `options.minSecretChars` | `4` chars | 1–64 | 1–8 | warn outside safe range | Shorter header values are not masked, so ordinary words survive; a high value leaks short secrets. |

### `markdown-knowledge` · KnowledgePort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.k` | `4` | 1–∞ | 1–50 | warn outside safe range | Number of passages returned when the query does not say how many. |

### `mcp` · KnowledgePort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.timeoutMs` | `60000` ms | 1–∞ or unbounded | 1–300000 | fail if unbounded; warn outside safe range | Bounds one request to the server, so a slow or silent server cannot hold a tool call. |
| `options.errorBodyChars` | `300` chars | 0–100000 | 0–2000 | warn outside safe range | Keeps a server error body short in messages and logs. |
| `options.minSecretChars` | `4` chars | 1–64 | 1–8 | warn outside safe range | Very short header values are left alone, because masking them would mangle ordinary text. |
| `options.stderrChars` | `2000` chars | 0–1000000 | 0–20000 | warn outside safe range | Keeps the tail of a stdio server's stderr for error messages without growing without bound. |
| `options.k` | `4` | 1–∞ | 1–50 | warn outside safe range | Number of passages returned when the query does not say how many. |

### `http-tools` · ToolPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.timeoutMs` | `30000` ms | 1–∞ or unbounded | 1–120000 | fail if unbounded; warn outside safe range | Bounds one request, so a slow API cannot hold a tool call. |
| `options.maxResultChars` | `16000` chars | 1–∞ or unbounded | 1–100000 | fail if unbounded; warn outside safe range | Keeps a large response from filling the model context. |
| `options.errorBodyChars` | `500` chars | 0–100000 | 0–2000 | warn outside safe range | Keeps an error body short in the result the model sees. |
| `options.minSecretChars` | `4` chars | 1–64 | 1–8 | warn outside safe range | Very short header values are left alone, because masking them would mangle ordinary text. |
| `options.tools.*.timeoutMs` | — | 1–∞ or unbounded | 1–120000 | fail if unbounded; warn outside safe range | Gives one tool its own time limit instead of the shared one. |
| `options.tools.*.maxResultChars` | — | 1–∞ or unbounded | 1–100000 | fail if unbounded; warn outside safe range | Gives one tool its own result cap instead of the shared one. |

### `mcp` · ToolPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.timeoutMs` | `60000` ms | 1–∞ or unbounded | 1–300000 | fail if unbounded; warn outside safe range | Bounds one request to the server, so a slow or silent server cannot hold a tool call. |
| `options.errorBodyChars` | `300` chars | 0–100000 | 0–2000 | warn outside safe range | Keeps a server error body short in messages and logs. |
| `options.minSecretChars` | `4` chars | 1–64 | 1–8 | warn outside safe range | Very short header values are left alone, because masking them would mangle ordinary text. |
| `options.stderrChars` | `2000` chars | 0–1000000 | 0–20000 | warn outside safe range | Keeps the tail of a stdio server's stderr for error messages without growing without bound. |
| `options.toolsTtlMs` | `60000` ms | 0–∞ | 0–3600000 | warn outside safe range | Decides how soon a change in the server's tool list is noticed; 0 reads it on every call. |
| `options.maxToolPages` | `100` | 1–∞ or unbounded | 1–1000 | fail if unbounded; warn outside safe range | Stops reading `tools/list` after this many pages, so a server that keeps returning a cursor cannot loop forever. |

### `openapi` · ToolPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.timeoutMs` | `30000` ms | 1–∞ or unbounded | 1–120000 | fail if unbounded; warn outside safe range | Bounds one request, so a slow API cannot hold a tool call. |
| `options.maxResultChars` | `16000` chars | 1–∞ or unbounded | 1–100000 | fail if unbounded; warn outside safe range | Keeps a large response from filling the model context. |
| `options.errorBodyChars` | `500` chars | 0–100000 | 0–2000 | warn outside safe range | Keeps an error body short in the result the model sees. |
| `options.minSecretChars` | `4` chars | 1–64 | 1–8 | warn outside safe range | Very short header values are left alone, because masking them would mangle ordinary text. |
| `options.specTimeoutMs` | `30000` ms | 1–∞ or unbounded | 1–120000 | fail if unbounded; warn outside safe range | Bounds the download of the spec at startup, so a slow host cannot block the stack. |
| `options.maxDescriptionChars` | `1000` chars | 1–100000 | 1–5000 | warn outside safe range | Keeps long operation descriptions from filling the model context. |
| `options.maxRefDepth` | `24` | 1–1000 | 1–100 | warn outside safe range | Cuts deeply nested or circular $refs instead of expanding them forever. |

### `authzen` · AuthorizationPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.timeoutMs` | `5000` ms | 1–∞ or unbounded | 1–30000 | fail if unbounded; warn outside safe range | Bounds one decision request, so a slow policy server cannot hold a tool call. |
| `options.maxResponseBytes` | `1000000` bytes | 1–∞ or unbounded | 1–10000000 | fail if unbounded; warn outside safe range | Stops a broken policy server from sending an endless answer. |
| `options.maxReasonChars` | `200` chars | 1–100000 | 1–2000 | warn outside safe range | The model sees the deny reason, so it is kept short. |

### `memory-approval` · ApprovalPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.ttlMs` | `unbounded` | 1–∞ or unbounded | — | warn if unbounded | Lets a request nobody answers expire instead of waiting forever. |

### `oidc` · CredentialPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.refreshSkewSec` | `30` s | 0–∞ | 0–300 | warn outside safe range | Renews a cached token a little early, so a call never starts with one about to expire. |
| `options.defaultTtlSec` | `60` s | 1–∞ | 1–3600 | warn outside safe range | Cache lifetime assumed when the provider gives no expiry. |
| `options.maxCacheEntries` | `1000` | 1–∞ or unbounded | 1–100000 | fail if unbounded; warn outside safe range | Caps the memory used by cached tokens. |
| `options.timeoutMs` | `10000` ms | 1–∞ or unbounded | 1–120000 | fail if unbounded; warn outside safe range | Bounds a token or discovery request, so a slow provider cannot hold a tool call. |
| `options.maxTokenChars` | `16384` chars | 1–∞ or unbounded | 1–65536 | fail if unbounded; warn outside safe range | Ignores the expiry of oversized tokens instead of parsing them. |
| `options.maxResponseBytes` | `1000000` bytes | 1–∞ or unbounded | 1–10000000 | fail if unbounded; warn outside safe range | Stops a hostile or broken provider from sending an endless document. |
| `options.errorDescriptionChars` | `200` chars | 0–10000 | 0–1000 | warn outside safe range | Keeps provider error text short in messages and logs. |

### `oidc` · IdentityPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.clockSkewSec` | `60` s | 0–600 | 0–120 | warn outside safe range | Allows for clock drift between the provider and this host; too wide a window accepts expired tokens. |
| `options.jwksMinRefreshMs` | `30000` ms | 1–∞ | 5000–3600000 | warn outside safe range | Stops a flood of unknown key ids from hammering the provider's key endpoint. |
| `options.jwksMaxAgeMs` | `600000` ms | 1–∞ | 10000–86400000 | warn outside safe range | Decides how soon a rotated or revoked key is noticed. |
| `options.timeoutMs` | `5000` ms | 1–∞ or unbounded | 1–120000 | fail if unbounded; warn outside safe range | Bounds a discovery or key set request, so a slow provider cannot hold a login. |
| `options.maxKeyTries` | `5` | 1–∞ | 1–20 | warn outside safe range | Bounds the signature checks spent on a token that names no key id. |
| `options.maxTokenChars` | `16384` chars | 1–∞ or unbounded | 1–65536 | fail if unbounded; warn outside safe range | Rejects oversized tokens before any parsing or key lookup. |
| `options.maxResponseBytes` | `1000000` bytes | 1–∞ or unbounded | 1–10000000 | fail if unbounded; warn outside safe range | Stops a hostile or broken provider from sending an endless document. |
| `options.errorDescriptionChars` | `200` chars | 0–10000 | 0–1000 | warn outside safe range | Keeps provider error text short in messages and logs. |

### `opa` · AuthorizationPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.timeoutMs` | `5000` ms | 1–∞ or unbounded | 1–30000 | fail if unbounded; warn outside safe range | Bounds one decision request, so a slow policy server cannot hold a tool call. |
| `options.maxResponseBytes` | `1000000` bytes | 1–∞ or unbounded | 1–10000000 | fail if unbounded; warn outside safe range | Stops a broken policy server from sending an endless answer. |
| `options.maxReasonChars` | `200` chars | 1–100000 | 1–2000 | warn outside safe range | The model sees the deny reason, so it is kept short. |

### `http-guard` · GuardPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.timeoutMs` | `10000` ms | 1–∞ or unbounded | 1–120000 | fail if unbounded; warn outside safe range | Bounds one check, so a slow guard service cannot hold a run. |
| `options.maxResponseBytes` | `1048576` bytes | 1–∞ or unbounded | 1–16777216 | fail if unbounded; warn outside safe range | Bounds the verdict read from the guard service, so a broken or hostile one cannot exhaust memory. |

### `llm-guard` · GuardPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.timeoutMs` | `30000` ms | 1–∞ or unbounded | 1–120000 | fail if unbounded; warn outside safe range | Bounds one check, so a slow scanner cannot hold a run. |
| `options.maxResponseBytes` | `1048576` bytes | 1–∞ or unbounded | 1–16777216 | fail if unbounded; warn outside safe range | Bounds the scan result read, so a broken or hostile service cannot exhaust memory. |

### `presidio` · GuardPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.timeoutMs` | `10000` ms | 1–∞ or unbounded | 1–120000 | fail if unbounded; warn outside safe range | Bounds one check, so a slow analyzer cannot hold a run. |
| `options.maxResponseBytes` | `1048576` bytes | 1–∞ or unbounded | 1–16777216 | fail if unbounded; warn outside safe range | Bounds the analyzer and anonymizer answers read, so a broken or hostile service cannot exhaust memory. |

### `a2a` · ChannelPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.maxTasksPerCaller` | `100` | 1–∞ or unbounded | 1–1000 | fail if unbounded; warn outside safe range | Stops one caller from filling the task store. |
| `options.maxTasks` | `10000` | 4–∞ or unbounded | 4–100000 | fail if unbounded; warn outside safe range | Caps the tasks kept in memory across all callers. |
| `options.taskTtlMs` | `3600000` ms | 1000–∞ | 1000–86400000 | warn outside safe range | Decides how long a finished task can still be read. |

### `mcp` · ChannelPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.sessionTtlMs` | `1800000` ms | 1000–∞ or unbounded | 1000–86400000 | fail if unbounded; warn outside safe range | Forgets sessions nobody uses, so clients that vanish do not pile up. |
| `options.maxSessionAgeMs` | `3600000` ms | 1000–∞ or unbounded | 1000–86400000 | fail if unbounded; warn outside safe range | Ends every session after a fixed time, however active it is. |
| `options.maxSessions` | `1000` | 1–∞ or unbounded | 1–100000 | fail if unbounded; warn outside safe range | Caps the memory held by open sessions. |
| `options.maxSessionsPerCaller` | `10` | 1–∞ or unbounded | 1–1000 | fail if unbounded; warn outside safe range | Stops one caller from taking all the sessions. |

### `jsonl-telemetry` · TelemetryPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.maxFileBytes` | `104857600` bytes | 1024–∞ or unbounded | 1024–1073741824 | warn if unbounded; warn outside safe range | Rotates the file at this size, so telemetry cannot fill the disk. |
| `options.maxFiles` | `5` | 1–100 | — | — | Rotated files kept; older ones are deleted. |

### `otlp` · TelemetryPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.intervalMs` | `2000` ms | 1–∞ | 100–60000 | warn outside safe range | Sets how often finished spans and metrics are sent to the collector. |
| `options.maxBatch` | `512` | 1–∞ | 1–10000 | warn outside safe range | Sends early once this many spans are waiting. |
| `options.maxQueue` | — | 1–∞ or unbounded | 1–100000 | fail if unbounded; warn outside safe range | Caps the spans held in memory while the collector is slow or down; without it, `maxBatch * 8`. |
| `options.timeoutMs` | `10000` ms | 1–∞ or unbounded | 1–120000 | fail if unbounded; warn outside safe range | Bounds one export request, so a stuck collector cannot hold the queue. |
| `options.errorMessageChars` | `200` chars | 0–100000 | 0–1000 | warn outside safe range | Limits how much of an error message is exported with captured content. |

### `expected-eval` · EvaluatorPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.maxQuoteChars` | `60` chars | 4–10000 | 4–500 | warn outside safe range | Keeps long expected answers short in score reasons. |

### `judge-eval` · EvaluatorPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.maxTokens` | — | 1–∞ | 1–4096 | warn outside safe range | Caps the judge answer, and so its cost and latency. |
| `options.maxReasonChars` | `300` chars | 1–100000 | 1–2000 | warn outside safe range | Keeps the judge reason short in scores and reports. |

### `layer-signals` · EvaluatorPort

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `options.reasonChars` | `160` chars | 1–100000 | 1–1000 | warn outside safe range | Limits how much of a stop reason's detail is kept in the llm and harness score reasons; the guardrail score reads the structured reason and needs no limit. |
| `options.previewItems` | `3` | 1–1000 | 1–20 | warn outside safe range | Limits how many guard or tool names a score reason lists. |

## Runtimes

### `pydantic-ai`

The Python runtime reads its limits from environment variables. It has no tier, so it cannot fail a check: it logs
one warning at startup for each limit that is `unbounded` or outside its safe range, and refuses values outside the
Accepted range.

| Setting | Default | Accepted | Safe range | On production | Why |
|---|---|---|---|---|---|
| `MAX_CONCURRENT_RUNS` | `8` | 1–∞ or unbounded | 1–64 | warn if unbounded; warn outside safe range | Runs in parallel; more would pile up model calls on the gateway. |
| `MAX_TASKS` | `1000` | 4–∞ or unbounded | 4–100000 | warn if unbounded; warn outside safe range | Tasks and conversations are kept in memory, so this bounds the memory of one process. |
| `MAX_TASKS_PER_OWNER` | — | 1–∞ | — | — | Stops one caller from filling the store; follows MAX_TASKS // 4 when unset. |
| `FINISHED_TASK_TTL_S` | `3600.0` s | 1.0–∞ or unbounded | 1.0–86400.0 | warn if unbounded; warn outside safe range | How long a finished task stays readable; kept forever if unbounded. |
| `IDLE_CONTEXT_TTL_S` | `3600.0` s | 1.0–∞ or unbounded | 1.0–86400.0 | warn if unbounded; warn outside safe range | How long an idle conversation keeps its history; kept forever if unbounded. |
| `CROSS_OWNER_MIN_AGE_S` | `600.0` s | 1.0–∞ | 1.0–86400.0 | warn outside safe range | Keeps recent work of other callers safe when a full store reclaims space. |
| `SHUTDOWN_GRACE_S` | `10.0` s | 1.0–∞ or unbounded | 1.0–300.0 | warn if unbounded; warn outside safe range | Time given to runs in flight on shutdown before they are cancelled. |
| `MODEL_TIMEOUT_S` | `120.0` s | 1.0–∞ or unbounded | 1.0–600.0 | warn if unbounded; warn outside safe range | Time limit of one model request; without it a stuck gateway blocks the run. |
| `MAX_MODEL_REQUESTS` | `8` | 1–∞ or unbounded | 1–50 | warn if unbounded; warn outside safe range | Model requests per run; stops a model that keeps calling tools. |

## Reference setups

The compose files under `reference/` are configuration themselves. Their policy limits read environment variables
with the defaults below (listed with the other compose overrides in [contracts.md](contracts.md#compose-overrides)).
Healthcheck timings and service-specific files (for example the LLM Guard `scanners.yml`) stay in the files.

| Variable | Default | Where | Why |
|---|---|---|---|
| `HOSTED_MAX_BUDGET_USD` | `1.0` | `reference/cache` | Spend cap of the optional hosted model group. |
| `HOSTED_BUDGET_DURATION` | `30d` | `reference/cache` | Period after which that spend cap resets. |
| `LITELLM_NUM_RETRIES` | `0` | `reference/cache` | Retries of the model gateway before the fallback group; 0 keeps fallback tests fast. |
| `CACHE_TTL_S` | `600` | `reference/cache` | Lifetime of cached answers in Valkey. |
| `PRESIDIO_ANALYZER_MEM_LIMIT` | `2g` | `reference/guardrail` | Memory cap of the Presidio analyzer container. |
| `PRESIDIO_ANONYMIZER_MEM_LIMIT` | `512m` | `reference/guardrail` | Memory cap of the Presidio anonymizer container. |
| `LLM_GUARD_MEM_LIMIT` | `3g` | `reference/guardrail` | Memory cap of the LLM Guard container. |

## reinloop

The reinloop runtime has its own limits, set in `reinloop.json` and checked when the file is loaded (warnings for
unsafe values). They are listed with the same columns in reinloop's
[configuration guide](https://github.com/aantenore/reinloop/blob/main/docs/configuration.md#limits). The
[`reinloop` adapter](#reinloop--runtimeport) above passes its budgets and tool limits through.

## Not limits

Some numbers stay in the code because a standard or a format fixes them: HTTP and JSON-RPC codes, protocol versions,
W3C trace id lengths and the 512-character `tracestate`, OpenTelemetry histogram buckets, private and loopback address
ranges, the RSA key minimum of 2048 bits, detector formats (card, IBAN and phone lengths, token patterns), id and
hash lengths, unit conversions and the four-characters-per-token estimate.
