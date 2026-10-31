# 0001 migration notes: adapters, hosts, runtimes, examples

Working checklist for step 6 and step 7 of [0001](0001-sdk-language.md#migration-plan). The core, the conformance
suites, the spec and the docs already speak language 1.0; every package below still speaks 0.x and fails to typecheck
(or to load) until it is migrated. Each section is self-contained: one owner per package, no edits outside it.

Sources of truth: [spec/language.md](../../spec/language.md), the port pages in [spec/ports](../../spec/ports/README.md),
the schemas in [spec/schemas](../../spec/schemas), and the binding in `packages/core/src` (`ports/*.ts`, `messages.ts`,
`ext.ts`, `vocab.ts`, `mappings.ts`, `names.ts`).

## Rules for every package

- Run only your package's tests and typecheck, plus its conformance suite; never the whole workspace suite.
- `portVersion: PORT_VERSIONS.<Port>` (now `1.0.0`). A hard-coded `0.x` no longer registers.
- Write `ext` keys only in your namespace (the adapter name, or `ext.namespace` on the descriptor) and list them in
  `ext.produces`; list keys of other namespaces you read in `ext.reads`. `sdk`, `agent`, `run`, `model` and `tool` are
  reserved. `checkAdapter` (conformance) fails on any undeclared key.
- Telemetry: the core names are in `ATTR`, `SPAN`, `METRIC`, `EVENT` (exported by the core). `agent.*` is the core's;
  an adapter's own spans, events and attributes use its namespace (`a2a.send`, `reinloop.compaction`). Never emit
  `gen_ai.*` except in `otlp`.
- Errors never become text a caller sees or a reason someone parses: stop reasons are `StopReason` objects; use
  `stopReasonOf(err)` for thrown errors.
- Translate at the edge with `ctx.mappings.in(native, shape)` / `ctx.mappings.out(shape, wire)` where the descriptor
  declares `mappingDefaults` (list per package below). Without rules they return the shape unchanged.
- After the package loads again: `npm run docs:adapters`, then `npm run docs:check` (the adapter rows of
  `docs/limits.md` only change if your limits change). Fix your README's links to renamed schemas.

## Core API: old to new

### Values

| Old | New |
|---|---|
| `contentText(content)` | `partsText(parts)`, `messageText(message)` |
| `lastUserText`, `newUserMessageIndexes` | same names, over `Message[]` |
| `responseText(res)` | `replyText(reply)` |
| `assembleChunks(chunks, model)` | `assembleDeltas(deltas, model)` |
| `responseToChunks(res)` | `replyToDeltas(reply)` |
| `toChatTools(specs)` | `toolInfos(specs)` |
| (new) | `textMessage(role, text)`, `callsOf(message)`, `parseArgs(text)` → `{args, invalid?}`, `addUsage(a, b)` |
| `publicIdentity(identity)` | `publicCaller(caller)`; `ANONYMOUS` for the explicit anonymous caller |
| `toolAccessRequest(tool, spec, args, ctx)` | `accessQuestion(tool, spec, args, ctx)` |
| `subjectOf(request)` | `policySubject(question, vocab?)` |
| `evaluatePolicy(rules, {tool, risk, identity})` | `evaluatePolicy(rules, {tool, risk, caller}, vocab?)` |
| `traceContext(traceparent, tracestate)` | removed: W3C parsing lives in the adapters that speak it |
| `traceHeaders(telemetry, fallback)` | `activeTrace(telemetry, fallback)` → `{parent, state?}`; write the headers yourself |
| `recordingTelemetry(write, name, {traceIds: true})` | `recordingTelemetry(write, name, {trace: codec})`, `codec: TraceCodec` |
| `new GuardrailBlocked(...).message` = `guardrail:<g>:<stage>` | `err.stopReason` = `{code: 'guard_block', layer: 'guardrail', by, stage}` |
| (new) | `stopReasonOf(err)`, `MappingError`, `fusePassages`, `Vocabularies`, `ATTR`/`SPAN`/`METRIC`/`EVENT` |

### Types

| Old | New |
|---|---|
| `ChatRequest {model, messages, tools, tool_choice, temperature, max_tokens, stop, extra}` | `ModelRequest {model, messages, tools?: ToolInfo[], toolMode?, settings?: {temperature, maxOutputTokens, stop}, ext?}` |
| `ChatMessage {role, content, tool_calls, tool_call_id}` | `Message {role: system\|user\|assistant\|tool, parts: Part[], ext?}` |
| `ContentPart` | `Part`: `text`, `media {mediaType, url?, data?}`, `call {id, tool, args, invalid?}`, `result {callId, ok, text, data?}`, `reasoning {text}`, or `<ns>.<name>` |
| `ToolCall {id, type, function: {name, arguments}}` | call part `{type: 'call', id, tool, args: object, invalid?}` |
| `ChatTool {type: 'function', function: {name, description, parameters}}` | `ToolInfo {name, description?, params}` |
| `tool_choice` | `toolMode: 'auto' \| 'none' \| 'required' \| {tool}` |
| `ChatResponse {id, model, choices[], usage, extra}` | `ModelReply {model, message, finish, usage?, id?, ext?}`; one answer, no `choices` |
| `FinishReason` `stop`, `length`, `tool_calls`, `content_filter` | `Finish` `end`, `limit`, `tools`, `refused`, `other` |
| `Usage {prompt_tokens, completion_tokens, total_tokens}` | `Usage {inputTokens, outputTokens, ext?}` |
| `ChatChunk`, `ToolCallDelta` | `ModelDelta`: `text`, `reasoning`, `call {index, id?, tool?, argsText?}`, `end {finish, usage?, model?, id?, ext?}` (exactly one, last) |
| `ToolSpec {inputSchema, meta}` | `ToolSpec {params, attrs?, ext?}` |
| `ToolOutcome {content, data, isError}` | `ToolResult {ok, text, data?, ext?}` |
| `ToolRisk` | `Risk` (extensible: `like`) |
| `Identity {subject, kind, roles?, scopes?, claims?, token?}` | `Caller {id, kind, roles: [], scopes: [], name?, credential?, ext?}` (lists always present) |
| `ctx.identity`, `InboundContext.identity`, `StartOptions.identity`, `TriggerSink.accept(t, {identity})` | `caller` everywhere |
| `CredentialPort.token(aud, {identity})` | `token(aud, {caller})`; on behalf of `caller.credential` |
| `AccessRequest {subject, action, resource, context}` | `AccessQuestion {caller, action: 'call', target: {kind, id, layer, risk, agent, attrs?}, args?, ext?}` |
| `AccessDecision {decision, context.reason}` | `AccessDecision {allowed, reason?, ext?}` |
| `ApprovalRequest.access` | `ApprovalRequest.question` |
| `GuardInput {subject}` | `GuardCheck {caller?, ext?}` |
| `GuardVerdict {action, text, reason}` | adds `labels?: GuardLabel[]` (`pii`, `secret`, `injection`, `toxicity`, `policy`, `other`); `reason` never parsed |
| `KnowledgeQuery {query, identity}` | `KnowledgeQuery {text, caller?, filter?: AttrFilter, ext?}` |
| `Passage {source?, metadata}` | `Passage {source (required), title?, url?, score?, attrs?, ext?}` |
| `KnowledgeDocument` | `Document {id, text, source?, title?, url?, attrs?, ext?}` |
| `MemoryScope.subject`, `MemoryItem.metadata`, `recall({query})` | `MemoryScope.caller`, `MemoryItem.attrs`, `recall({text})` |
| `AgentSpec.params` | `AgentSpec.settings` + `ext`; `params` in config or agent files is a load error |
| `RunStatus` incl. free strings | `completed`, `failed`, `stopped`, `waiting` |
| `RunResult.reason: string` | `RunResult.reason: StopReason {code, layer?, by?, stage?, detail?}` (required when not completed) |
| `RunEvent {type: string, ...}` | core events below, or `<ns>.<name>` events |
| `Trigger {type, time}` | `Trigger {kind, at, ext?}` |
| `Feedback {subject, time}` | `Feedback {by, at, ext?}` |
| `EvalCase.input: string` | `EvalCase.input: RunInput`; `EvalRun.reason?`, `EvalResult.reason?` |
| `TraceContext {traceparent, tracestate}` | `TraceContext {parent, state?}`, opaque to the core |
| descriptor | adds `ext?`, `vocabularies?`, `mappingDefaults?`; `AdapterContext` adds `mappings` |

Core run events (fixed payloads): `run.start {runId, agent}`, `model.reply {turn, model, finish, calls}`,
`tool.call {id, tool}`, `tool.result {id, tool, ok, durationMs?}`, `text {text}`, `run.end {status, reason?, usage?,
costUsd?}`; each may carry `at`.

Governed tool results (what a runtime gets from `stack.toolsFor(agent)`) carry `ext["sdk.outcome"]` (`ok`, `error`,
`denied`, `blocked`, `redacted`, `pending`); a call waiting for a person also carries `ext["sdk.approval"]` (approval
id) and `ok: false`. A runtime ends such a run with status `waiting` and reason `{code: 'needs_input', layer:
'identity', by: '<approval instance>', detail: '<approval id>'}`.

Telemetry names (old → new): `invoke_agent` → `agent.run`; `chat` → `agent.model.call`; `execute_tool` →
`agent.tool.call`; `authorize` → `agent.access.check`; `guard.check` → `agent.guard.check`; `knowledge.search` →
`agent.knowledge.search`; `cache.lookup` → `agent.cache.lookup`; `router.select` → `agent.router.select`;
`knowledge.error` → `agent.knowledge.error`; `gen_ai.client.token.usage` + `gen_ai.token.type` → `agent.model.tokens`
+ `agent.tokens.kind`; `agent.policy.decisions` → `agent.access.decisions`; `agent.guardrail.actions` →
`agent.guard.actions`; `run.id`, `gen_ai.agent.name`, `run.status`, `run.reason` → `agent.run.id`, `agent.name`,
`agent.run.status`, `agent.run.reason` (the stop code); `gen_ai.request.model`, `gen_ai.response.model` →
`agent.model.requested`, `agent.model.used`; `gen_ai.usage.*_tokens` → `agent.tokens.input|output`;
`gen_ai.response.finish_reasons` → `agent.model.finish`; `gen_ai.tool.name`, `tool.source`, `tool.outcome` →
`agent.tool.*`; `guard.*` → `agent.guard.*`; `policy.decision|reason` → `agent.access.decision|reason`; `cache.hit`,
`router.model`, `knowledge.*` → under `agent.`; `trigger.type` → `agent.trigger.kind`; `error.message` →
`agent.error`. New: `agent.ext.dropped`, `agent.config.warning`.

### Conformance API

`sampleAccess` → `sampleQuestion`. Fixture renames: credentials `identity` → `caller` (with `credential`); identity
`expectSubject` → `expectId`; tools `isError` → `ok`, `expect` checks `text`; authorization `allow`/`deny` are
`AccessQuestion[]`; telemetry gains `trace?: {parent, sameTrace(parent, inside)}`. New: `checkExt(descriptor, value)`,
`roundTrip(samples, toLanguage, toStandard, {shape?, equal?})`. `checkAdapter` now fails on undeclared `ext` keys.

## Model group

### `openai-compatible` (outbound ModelPort, inbound ChannelPort)

- Descriptor: `ext: {namespace: 'openai', produces: ['openai.usage', 'openai.choices', 'openai.finish_reason',
  'openai.role', ...the request passthrough keys you keep]}`. Keys in its own namespace need no `reads`.
- `src/wire.ts`: a real translation both ways (no `messages: req.messages`). Out: `system` → `system`; `user` text and
  media parts → `content` string or parts (`image_url`, `input_audio`); assistant text → `content`, call parts →
  `tool_calls[{id, type: 'function', function: {name: tool, arguments: invalid ?? JSON.stringify(args)}}]`; each
  `result` part of a `tool` message → one `{role: 'tool', tool_call_id: callId, content: text}` (`ok: false` has no wire
  field); reasoning parts are not sent unless the backend accepts them. `tools` from `ToolInfo` (`parameters` =
  `params`); `toolMode` → `tool_choice` (`{tool}` → `{type: 'function', function: {name}}`); `settings.temperature`,
  `maxOutputTokens` → `max_tokens` (or `max_completion_tokens` by option), `stop`; `ext["openai.<field>"]` → the
  passthrough fields (`response_format`, `seed`, `top_p`, `logit_bias`, `parallel_tool_calls`, `n` via `openai.n`).
- In (reply): `choices[0].message` → parts: `reasoning_content`/`reasoning` → reasoning part, `content` → text part,
  `tool_calls` → call parts through `parseArgs`. Other choices → `ext["openai.choices"]`. `finish_reason`: `stop` →
  `end`, `length` → `limit`, `tool_calls`/`function_call` → `tools`, `content_filter` → `refused`, anything else →
  `other` with the native value in `ext["openai.finish_reason"]`; keep the invariant (`tools` exactly when there are
  call parts). Usage: `prompt_tokens` → `inputTokens`, `completion_tokens` → `outputTokens`, details →
  `ext["openai.usage"]`.
- Stream: each chunk → `ModelDelta` (`delta.content` → `text`, reasoning → `reasoning`, `tool_calls[i]` → `call {index,
  id, tool: function.name, argsText: function.arguments}`), then exactly one `end {finish, usage, model, id}` (send
  `stream_options.include_usage`).
- Trace: `const t = activeTrace(ctx.telemetry, ctx.trace)`; headers `traceparent: t.parent`, `tracestate: t.state`.
- `src/inbound.ts`: wire request → `RunInput {messages}` (role `developer` → `system` with
  `ext["openai.role"] = 'developer'`, or through the `role` vocabulary aliases: `stack().vocabularies.resolve('role',
  r)`); `PASSTHROUGH`/`ROLES` lists become the `openai.*` ext keys. Hosted model route (`model` not `agent:`): wire →
  `ModelRequest` → `host.model().chat` → `ModelReply` → wire, with the same tables. Run → response: `completed` →
  `stop`; `stopped` → `content_filter` (reason stays inside); `waiting` → `stop` with the output so far (or a 409 if
  you prefer; document it); `failed` → 500. Stream: `text` events → `delta.content`; `run.end` → `finish_reason` and
  `usage` (`inputTokens` → `prompt_tokens`). `GuardrailBlocked` → `content_filter` as today. `InboundContext.caller`
  and `.trace` go into the run context unchanged.
- Tests: round trips with `roundTrip` (wire → language → wire) for messages, replies and chunks.

### `mock-model`

- Build `ModelReply`/`ModelDelta`; scripts match on `messageText`/`lastUserText`; `ChatTool` → `ToolInfo`; `tool_choice`
  → `toolMode`; usage in `inputTokens`/`outputTokens`; finish `end`/`tools`.
- Test: `assembleChunks` → `assembleDeltas`.

### `rule-router`

- `select(req: ModelRequest)`: `tool_choice` → `toolMode`; `tool_calls` → `callsOf(message)`; `contentText` →
  `messageText`; roles unchanged except `developer` (gone).

### `static-router`, `memory-cache`

- `portVersion` only. Note: reply cache keys are now `model:<sha256>`; old cache entries are simply not hit.

## Agent group

### `mcp` (outbound ToolPort and KnowledgePort, inbound ChannelPort)

- Descriptor: `ext: {produces: ['mcp.annotations', 'mcp.meta', 'mcp.content']}` (replaces the un-namespaced
  `meta.mcp`).
- Tools in: `inputSchema` → `params`; `title` → `attrs.title` if wanted; `annotations` → `ext["mcp.annotations"]`,
  `_meta` → `ext["mcp.meta"]`. Risk as `mappingDefaults.in` on `ToolSpec` (replaceable by config):
  `[{from: '/annotations/destructiveHint', to: '/risk', map: {true: 'exec', false: 'write'}, default: 'exec'},
  {from: '/annotations/readOnlyHint', to: '/risk', map: {true: 'read'}}]` (an unlisted value is not written; the
  default is final, so a missing hint is `exec`). Apply
  `ctx.mappings.in(mcpTool, spec)`.
- Call: `args` sent as the object (no string round trip). Result: text items of `content[]` joined → `text`;
  `structuredContent` → `data`; `ok = !isError`; images and resources → `ext["mcp.content"]`.
- Knowledge: send `q.text` under the configured argument (`queryArg`, default `query`); passages parsed as today, their
  metadata → `attrs` (and `title`, `url`) through `mappingDefaults.in` on `Passage`; `source` = instance name.
- Server: governed tools out → MCP `tools/list` (`inputSchema` = `params`, `annotations` from `risk`:
  `readOnlyHint = risk read`, `destructiveHint = risk exec`), `tools/call` → `{content: [{type: 'text', text}],
  structuredContent: data, isError: !ok}`; caller from `InboundContext.caller` (owner key `caller.kind`/`caller.id`).
- `client.ts`: `traceHeaders` → `activeTrace` + header names. Tests: `trace.test.ts` uses `{parent}` contexts.

### `functions`

- `ToolDef.inputSchema` → `params`; returns `{ok, text, data?}` (accept a plain string as `{ok: true, text}`);
  `ctx.identity` → `ctx.caller`. Test helpers: `Caller` instead of `Identity`.

### `http-tools`, `openapi`

- `inputSchema` → `params`; `ToolOutcome` → `ToolResult` (`isError` → `!ok`, `content` → `text`); `ToolRisk` → `Risk`.
- Optional `mappingDefaults.in` on `ToolSpec` (OpenAPI `x-*` extensions → `attrs`/`risk`).

### `markdown-knowledge`, `http-knowledge`

- `q.query` → `q.text`; `metadata` → `attrs` (`file`, `heading`) plus `title`, `url` where known; `source` =
  `ctx.name`. `mappingDefaults: {in: {shape: 'Passage'}}` and `ctx.mappings.in(native, passage)`.
- `http-knowledge`: its HTTP body is its own wire (keep `{query, k, filter}` or move to `text`, and say so in the
  README); `q.identity?.token` → `q.caller?.credential`; README link `knowledge-document.json` → `document.json`.

### `basic-runtime`

- Messages as parts: `textMessage('system', instructions)`, user input `textMessage('user', text)`; assistant reply
  message appended as is; tool results as `{role: 'tool', parts: [{type: 'result', callId, ok, text, data?}]}`.
- `toChatTools` → `toolInfos`; `PARAM_KEYS`/`params`/`extra` → `spec.settings` and `spec.ext` (own keys
  `basic-runtime.*`).
- Usage via `addUsage`; finish `tools` drives the loop (not `finish_reason`).
- Events: `run.start`, `model.reply {turn, model, finish, calls}`, `text`, `tool.call {id, tool}`, `tool.result {id,
  tool, ok, durationMs}`, `run.end {status, reason?, usage?, costUsd?}` (stream and run).
- Reasons: guard blocks → `err.stopReason`; turn limit → `{code: 'limit', layer: 'harness', detail: 'turns'}`; errors
  → `stopReasonOf(err)`; a governed result with `ext["sdk.approval"]` ends the run `waiting` (shape in "Core API").

### `reinloop`

- `convert.ts` becomes near one to one: reinloop parts ↔ `Part`; `FinishReason` mapping ↔ `Finish`; usage names
  already match (`inputTokens`/`outputTokens`).
- `AgentSpec.params` → `settings` (`maxOutputTokens`) and `ext["reinloop.*"]`.
- Events: `run_start` → `run.start`; `model_response {finish_reason, toolCalls, usage, costUsd}` → `model.reply {turn,
  model, finish, calls}` (per-turn usage/cost in a `reinloop.usage` event if still needed); `tool_call {name}` →
  `tool.call {tool}`; `tool_result {name, isError}` → `tool.result {tool, ok}`; `compaction` → `reinloop.compaction`;
  `tool_args_invalid` → `reinloop.args_invalid`; `run_end` → `run.end`.
- Reasons: `budget:<limit>` → `{code: 'limit', layer: 'harness', by: 'reinloop', detail: '<limit>'}`; interrupted →
  `aborted`; guard → `stopReason`; other errors → `stopReasonOf(err)` (never `errorMessage(err)` as the reason);
  pending approvals → `waiting`.
- Telemetry: metrics `agent.compaction`, `agent.tool.args_invalid`, `agent.budget.exceeded`, `agent.cost.usd` →
  `reinloop.*`; drop `gen_ai.*` attributes; do not open `chat`/`execute_tool` spans for calls that already go through
  the stack's governed model and tools (they are spanned as `agent.model.call`/`agent.tool.call`).
- `publicIdentity(ctx.identity)` → `publicCaller(ctx.caller)`.

### `memory-state`, `sqlite-state`

- `portVersion`; store `RunEvent` as is. Old logs are not converted. Tests use `run.start`/`run.end`.

## Control group

### `oidc` (IdentityPort, CredentialPort)

- `verify` returns `Caller`: `id` = `sub` (or the client id as today), `kind` logic unchanged, `credential` = the
  token, `roles`/`scopes` always lists.
- `rolesOf` (Keycloak layout) becomes `mappingDefaults.in` on `Caller`, replaceable by config:
  `[{from: ['/realm_access/roles', '/roles'], to: '/roles', join: 'union'}, {from: '/scope', to: '/scopes', split: ' '},
  {from: '/preferred_username', to: '/name'}]`. Two things stay in code: `resource_access.<client>.roles` (a static
  rule cannot name the configured client) and merging the `scp` list with the split `scope` string. Apply `ctx.mappings.in(claims, caller)` after verification; a `MappingError`
  rejects the credential.
- Claims: only with `keepClaims: true`, under `ext["oidc.claims"]`. The credential adapter's expiry check needs the
  expiry without the claims: produce `ext["oidc.exp"]` always (same namespace). Declare
  `ext: {produces: ['oidc.claims', 'oidc.exp', ...]}`.
- `CredentialPort.token(aud, {caller})`: `subject_token` = `caller.credential`.
- Tests: `toolAccessRequest` → `accessQuestion`; span `authorize` → `agent.access.check`.

### `static-identity`

- Returns `Caller {id, kind, roles: [], scopes: [], credential}`; the `claims` option → `ext["static-identity.claims"]`
  or remove it (clean break). `CredentialPort`: `{caller}`.

### `authzen`

- `AccessQuestion` → AuthZEN wire (the [ADR table](0001-sdk-language.md#openid-authzen-authzen-authorizationport)):
  `subject {type: caller.kind, id, properties: {roles, scopes, authenticated: kind !== 'anonymous'}}`, `action
  {name}`, `resource {type: target.kind, id, properties: {risk, layer, agent, ...attrs}}`, `context.args` only with
  `includeArgs`. Then `ctx.mappings.out(question, wire)`.
- `mappingDefaults: {out: {shape: 'AccessQuestion'}}`. Decision: `decision` → `allowed`; `context.reason` (or
  `reason_user`) → `reason`; other `context` keys → `ext["authzen.context"]`. A `MappingError` denies.

### `opa`

- `input` = the `AccessQuestion` as is (`input.caller.roles`, `input.target.risk`), after `ctx.mappings.out(question,
  question)`. Delete `src/pdp.ts` (the AuthZEN copy). Result `true`/`false` or `{allow, reason}` → `{allowed, reason}`.
- `mappingDefaults: {out: {shape: 'AccessQuestion'}}`.

### `rules-authorization`

- `subjectOf(req)` → `policySubject(q, vocab)` with `vocab = ctx.stack?.().vocabularies` read at call time (so
  config-added risks match `like` rules); return `{allowed, reason}`. Options schema: `risk` items are strings.

### `memory-approval`

- `ApprovalRequest.question`; otherwise unchanged.

### Guards: `presidio`, `llm-guard`, `regex-guard`, `http-guard`, `_template`

- Input type `GuardCheck` (`caller` instead of `subject`).
- Verdicts add `labels`; native names go to `ext` (`presidio.entities`, `llm-guard.scanners`, `regex-guard.rules`) and
  are declared. `reason` stays free text (never parsed). Presidio: entity types → labels through
  `mappingDefaults.in` on `GuardVerdict`, for example `{from: '/entities', to: '/labels', map: {EMAIL_ADDRESS: 'pii',
  PHONE_NUMBER: 'pii', CREDIT_CARD: 'pii', '*': 'other'}}`.
- `http-guard`: the body it posts becomes a `GuardCheck`; parse `labels` in the verdict; README link
  `guard-request.json` → `guard-check.json`.

## Experience group

### `cloudevents`

- `Trigger {id: <SDK id>, kind: type, source, at: time, agent, data, ext}` with `ext["cloudevents.id"]` (the upstream
  id, to deduplicate redeliveries), `ext["cloudevents.subject"]` and other attributes (`datacontenttype`,
  `dataschema`, extensions) under `cloudevents.*`. Optional `mappingDefaults.in` on `Trigger`.
- `accept(trigger, {caller})`.

### `terminal-channel`

- Show a stopped run from `reason.code` (and `reason.by`), not by parsing; `waiting` is a distinct state.

### `a2a` (outbound RuntimePort, inbound ChannelPort)

- Client: input text via `messageText`; trace via `activeTrace`; credentials `token(aud, {caller})`. Remote task state
  → `RunResult`: `completed` → `completed`; `canceled` → `stopped` + `aborted`; `rejected` → `stopped` + `rejected`;
  `input-required` → `waiting` + `needs_input`; `auth-required` → `waiting` + `needs_auth`; `failed` → `failed` +
  `error`; `by` = the remote agent. Optional `mappingDefaults.in` on `RunResult`.
- Server: `stateOfRun` reads `status` and `reason.code` (no `guardrail:` regex): `stopped` + `guard_block` →
  `rejected`; `stopped` + `aborted` → `canceled`; `waiting` + `needs_input`/`needs_auth` →
  `input-required`/`auth-required`; `failed` → `failed`. Task `metadata["agent-layers"] = {usage: {inputTokens,
  outputTokens}, costUsd}`. Owner key from `InboundContext.caller`.
- Span `a2a.send` keeps its name; attributes `agent.name`, `agent.run.id` instead of `gen_ai.agent.name`, `run.id`.

## Insight group

### `otlp`

- Owns the standard names: map `agent.*` → OpenTelemetry GenAI per the [ADR table](0001-sdk-language.md#opentelemetry-otlp-otlp-telemetryport):
  `agent.run` → `invoke_agent <agent>` (+ `gen_ai.operation.name`, `gen_ai.agent.name`); `agent.model.call` → `chat
  <model>` (kind CLIENT, `gen_ai.request.model`, `gen_ai.response.model`); `agent.tokens.*` → `gen_ai.usage.*_tokens`;
  `agent.model.finish` → `gen_ai.response.finish_reasons` (`end` → `stop`, `limit` → `length`, `tools` →
  `tool_calls`, `refused` → `content_filter`); `agent.tool.call` + `agent.tool.name` → `execute_tool <tool>` +
  `gen_ai.tool.name`; metric `agent.model.tokens` + `agent.tokens.kind` → `gen_ai.client.token.usage` +
  `gen_ai.token.type`; `gen_ai.client.operation.duration` from `agent.model.call`. Other `agent.*` pass unchanged.
- Trace: `traceContext` is gone from the core. Implement the W3C codec here (parse `00-<32 hex>-<16 hex>-<2 hex>`,
  refuse version `ff` and all-zero ids, drop a malformed `tracestate`, at most 512 printable characters; the previous
  implementation is `traceContext` in `packages/core/src/telemetry.ts` at commit `999e771`). `SpanOptions.parent` and
  `current()` use `{parent, state}`; an invalid parent starts a new trace.

### `console-telemetry`, `jsonl-telemetry`

- Names come from the core as `agent.*`; nothing to rename unless the formatter matches old names.
- `jsonl-telemetry` `traceIds: true` → pass a W3C `TraceCodec` to `recordingTelemetry(write, name, {trace: codec})`
  (same codec as `otlp`; the two packages do not depend on each other, so each carries a small copy or one exports
  it for the other — owner's choice).

### `layer-signals`

- Read the core names (`SPAN`, `ATTR`): `agent.run` (`agent.run.status`, `agent.run.reason`), `agent.guard.check`
  (`agent.guard.*`), `agent.access.check` (`agent.access.decision`), `agent.tool.call` (`agent.tool.outcome`,
  `agent.tool.name`), `agent.knowledge.search` (`agent.knowledge.passages`), `agent.model.call`
  (`agent.model.finish`), `agent.cache.lookup` (`agent.cache.hit`).
- Events: `run.end.reason.code === 'guard_block'` replaces the `guardrail:` regexes (`GUARDRAIL_REASON`); `tool.result.ok ===
  false`; `model.reply.finish === 'limit'` replaces the `max_tokens` regex. `EvalRun.reason` is structured.

### `judge-eval`

- `ModelRequest {messages: [textMessage('system', ...), textMessage('user', ...)], settings: {temperature,
  maxOutputTokens}, ext}` (option `extra` → `ext` keys in the model adapter's namespace, for example `openai.seed`;
  document the change); answer via `replyText`. Telemetry attributes via `ATTR`.

### `expected-eval`, `compose-deploy`

- `portVersion`; `expected-eval` compares `status` values (now including `waiting`).

## Hosts

### `packages/gateway`

- `InboundContext.caller`; `StartOptions.caller`; `verify` → `Caller`.
- Trace: copy `traceparent`/`tracestate` headers into `trace: {parent, state}` unchanged (bound the length; the core
  does not validate); span `gateway.request` keeps its name (it is the gateway's own) with `agent.layer`.
- Trigger runs: `trigger.kind`; attributes `agent.trigger.kind`, `agent.name`, `agent.run.id`, `agent.run.status`.
- Readiness: `problems[].slot` is optional (`kind: 'language'` has none); show `readiness.warnings`.

### `packages/cli`

- `trace.ts` attribute keys → `agent.tool.name`, `agent.guard.stage`, `agent.guard.action`, `agent.cache.hit`,
  `agent.router.model`, `agent.knowledge.passages`, `agent.access.decision`, `agent.tool.outcome`, `agent.run.status`.
- `identity.ts`, `dev.ts`, `conform.ts`: `Identity` → `Caller` (`--token` becomes `caller.credential`; conformance
  fixture `caller`).
- `eval.ts`: reason is a `StopReason` (print `reason.code`); errors via `stopReasonOf`.
- `check`: print `readiness.warnings` and language problems.
- `templates/minimal/tools/convert.ts`: `params`, `ToolResult`. Tests: `e2e.test.ts` on `ModelRequest`/`ModelReply`.

## Runtimes, reference, examples

### `runtimes/pydantic-ai`

- The A2A and OpenAI wires it speaks do not change. If it reads task `metadata["agent-layers"]`, usage is
  `{inputTokens, outputTokens}`.
- `spec.py`: agent files with `params` are now rejected by the core loader; read `settings` if the runtime needs it.
- `test-e2e.mjs`: span names `agent.access.check`, `agent.tool.call`, `agent.guard.check`, `agent.model.call`;
  attributes `agent.tool.name`, `agent.access.decision`, `agent.tool.outcome`, `agent.guard.stage`,
  `agent.model.requested`.

### `reference/*`

- `reference/identity/policies/agents.rego` (+ test): `input.subject.type` → `input.caller.kind`, `input.subject.id`
  → `input.caller.id`, `input.subject.properties.roles` → `input.caller.roles`,
  `input.subject.properties.authenticated` → `input.caller.kind != "anonymous"`, `input.resource.properties.risk` →
  `input.target.risk`.
- Agent files with `params` (`reference/harness/agents/assistant.md`, `reference/eval/agents/smoke.md`,
  `reference/eval/agents/diagnose.md`) stay: they are reinloop agent files (loaded by reinloop, which refuses
  `settings`), not SDK agent files.
- Layers outside identity and guardrail run on reinloop directly: their `params`, events, spans and `isError` are
  reinloop's own language or its OpenTelemetry GenAI export, not the SDK's, and do not change.
- `reference/guardrail/README.md`: link `guard-request.json` → `guard-check.json`.

### `examples/*`

- `examples/minimal/tools/convert.ts`, `examples/slice/tools/tools.ts`: `params`, return `{ok, text}`;
  `ctx.identity?.subject` → `ctx.caller?.id`.
- `examples/minimal/tests/agent.test.ts`: `run.reason` is a `StopReason`; callers instead of identities.
- Agent files need no change (no `params`). Stored telemetry under `.agent-layers/` is old data; regenerate it with the
  slice (`scripts/slice.mjs`) once at the end.
