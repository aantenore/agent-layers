# The SDK language

Version 1.0.

The data that crosses a port is written in one language owned by this project: fixed and minimal at the core, versioned as a whole, extensible through declared extensions. Standards and technologies appear only inside adapters, which translate at the edges. The reasoning is in [ADR 0001](../docs/decisions/0001-sdk-language.md); this page is the reference.

Four rules carry the rest:

1. A field enters a shape only when the core reads it, or when two or more adapters of different standards need it. Everything else goes in `ext`.
2. Vocabularies (sets of allowed values) and boundary mappings are configurable. Shapes and field names are not.
3. Standards live in adapters. N standards need N translations to the language, not N×M between them.
4. The JSON Schemas in [`schemas/`](schemas/) are the definition. `common.json` holds what they share.

## Naming rules

| Rule | Example |
| --- | --- |
| Short plain-English names, camelCase fields | `inputTokens`, `callId` |
| `type` only discriminates a union; `kind` classifies | `{ "type": "text" }`, `caller.kind` |
| Times are ISO 8601 strings named `at` or `<x>At` | `trigger.at`, `approval.request.expiresAt` |
| Identifiers are `id` or `<x>Id` | `runId`, `callId` |
| Telemetry names start with `agent.` | `agent.tool.call` |
| No name that belongs to one standard, unless it is ordinary English | `source` and `data` stay; a wire-format field name does not |
| JSON Schema is the one schema notation | `ToolSpec.params` |

## Shapes

Every shape has an optional `ext` unless its schema says otherwise. Fixed shapes reject unknown fields.

| Shape | Schema | Port |
| --- | --- | --- |
| `ModelRequest` | [`model-request.json`](schemas/model-request.json) | [`ModelPort`](ports/ModelPort.md), [`RouterPort`](ports/RouterPort.md), [`CachePort`](ports/CachePort.md) |
| `ModelReply` | [`model-reply.json`](schemas/model-reply.json) | [`ModelPort`](ports/ModelPort.md) |
| `ModelDelta` | [`model-delta.json`](schemas/model-delta.json) | [`ModelPort`](ports/ModelPort.md) |
| `Message`, `Part` | [`message.json`](schemas/message.json) | [`ModelPort`](ports/ModelPort.md) |
| `ToolSpec` (and `ToolInfo`, what the model sees) | [`tool-spec.json`](schemas/tool-spec.json) | [`ToolPort`](ports/ToolPort.md) |
| `ToolResult` | [`tool-result.json`](schemas/tool-result.json) | [`ToolPort`](ports/ToolPort.md) |
| `Passage` | [`passage.json`](schemas/passage.json) | [`KnowledgePort`](ports/KnowledgePort.md), [`MemoryPort`](ports/MemoryPort.md) |
| `Document` | [`document.json`](schemas/document.json) | [`IngestionPort`](ports/IngestionPort.md) |
| `Caller` (public: no credential) | [`caller.json`](schemas/caller.json) | [`IdentityPort`](ports/IdentityPort.md), [`CredentialPort`](ports/CredentialPort.md) |
| `AccessQuestion` | [`access-question.json`](schemas/access-question.json) | [`AuthorizationPort`](ports/AuthorizationPort.md) |
| `AccessDecision` | [`access-decision.json`](schemas/access-decision.json) | [`AuthorizationPort`](ports/AuthorizationPort.md) |
| `Approval` | [`approval.json`](schemas/approval.json) | [`ApprovalPort`](ports/ApprovalPort.md) |
| `GuardCheck` | [`guard-check.json`](schemas/guard-check.json) | [`GuardPort`](ports/GuardPort.md) |
| `GuardVerdict` | [`guard-verdict.json`](schemas/guard-verdict.json) | [`GuardPort`](ports/GuardPort.md) |
| `AgentSpec` | [`agent-spec.json`](schemas/agent-spec.json) | [`RuntimePort`](ports/RuntimePort.md) |
| `RunResult` | [`run-result.json`](schemas/run-result.json) | [`RuntimePort`](ports/RuntimePort.md), [`ChannelPort`](ports/ChannelPort.md) |
| `RunEvent` | [`run-event.json`](schemas/run-event.json) | [`StatePort`](ports/StatePort.md), [`RuntimePort`](ports/RuntimePort.md) |
| `Trigger` | [`trigger.json`](schemas/trigger.json) | [`TriggerPort`](ports/TriggerPort.md) |
| `EvalCase` | [`eval-case.json`](schemas/eval-case.json) | [`EvaluatorPort`](ports/EvaluatorPort.md) |
| `EvalResult` (with `EvalScore`) | [`eval-result.json`](schemas/eval-result.json) | [`EvaluatorPort`](ports/EvaluatorPort.md) |
| `Feedback` | [`feedback.json`](schemas/feedback.json) | [`FeedbackPort`](ports/FeedbackPort.md) |

Shapes defined on their port page only: `KnowledgeQuery`, `MemoryScope`, `MemoryItem`, `CallContext`, `InboundContext`. Shared definitions (`Ext`, `Attrs`, `AttrFilter`, `Part`, `Usage`, `StopReason`, `PublicCaller` and every vocabulary) are in [`schemas/common.json`](schemas/common.json).

Rules that cross shapes:

- `Message.parts` is always a list. `system` messages hold text, `user` text and media, `assistant` text, reasoning and calls, `tool` results. Adapter parts (`<namespace>.<name>`) may appear in any role.
- A `ModelReply` is one answer. Its `finish` is `tools` exactly when its message has at least one `call` part.
- Tool errors are results (`ok: false`), not exceptions. A call part's `args` is always an object; text that did not parse is kept in `invalid`.
- `Caller.credential` exists in memory only. It is never serialised, logged or traced, so `caller.json` has no such property.
- `AccessQuestion.caller` is a public caller or the explicit anonymous caller `{ "kind": "anonymous", "id": "anonymous", "roles": [], "scopes": [] }`. Anonymous is never the agent.

## Vocabularies

A vocabulary is a set of values defined by the SDK. The core branches only on core values.

| Vocabulary (config key) | Core values | Extensible | Used by |
| --- | --- | --- | --- |
| `layer` | the eleven layer ids | no | everything |
| `role` | `system`, `user`, `assistant`, `tool` | aliases only | `Message.role` |
| `part` | `text`, `media`, `call`, `result`, `reasoning` | namespaced types pass through | `Part.type` |
| `finish` | `end`, `limit`, `tools`, `refused`, `other` | values with `like` | `ModelReply.finish` |
| `risk` | `read`, `write`, `exec` | values with `like` | `ToolSpec.risk`, policy rules |
| `effect` | `allow`, `ask`, `deny` | no | policy rules |
| `action` | `call` | values with `like` | `AccessQuestion.action` |
| `stage` | `input`, `output`, `tool_args`, `tool_result` | no | `GuardCheck.stage` |
| `guardAction` | `allow`, `block`, `redact` | no | `GuardVerdict.action` |
| `guardLabel` | `pii`, `secret`, `injection`, `toxicity`, `policy`, `other` | values with `like` | `GuardVerdict.labels` |
| `runStatus` | `completed`, `failed`, `stopped`, `waiting` | no | `RunResult.status` |
| `stopCode` | `guard_block`, `denied`, `aborted`, `timeout`, `limit`, `needs_input`, `needs_auth`, `rejected`, `error` | values with `like` | `RunResult.reason.code` |
| `event` | `run.start`, `model.reply`, `tool.call`, `tool.result`, `text`, `run.end` | namespaced types | `RunEvent.type` |
| `callerKind` | `user`, `agent` (`anonymous` only inside `AccessQuestion`) | no | `Caller.kind` |
| `approvalStatus` | `pending`, `approved`, `denied`, `expired` | no | `Approval.status` |

In the schemas, closed vocabularies are enums. Vocabularies config can extend (`finish`, `risk`, `action`, `guardLabel`, `stopCode`) are strings that match `^[a-z][a-z0-9_.-]{0,63}$`, with the core values in the description.

Config extends a vocabulary with a `vocabularies` block (also allowed per profile):

```json
{ "vocabularies": {
  "risk": { "add": { "admin": { "like": "exec" } } },
  "guardLabel": { "add": { "pii.health": { "like": "pii" } } },
  "finish": { "aliases": { "pause": "other" } },
  "role": { "aliases": { "developer": "system" } } } }
```

Rules, checked when the config loads:

| Rule | Detail |
| --- | --- |
| `add` needs `like` | The value names a core value of the same vocabulary. Core logic sees the `like` value; adapters and telemetry see the added value. A policy rule on `risk: ["exec"]` also matches `admin`. |
| Names | Match `^[a-z][a-z0-9_.-]{0,63}$` and collide with no core value, added value or alias. |
| Aliases | Map a name to an existing value. Adapters resolve them at the edge; they never reach the core. |
| Closed vocabularies | `no` rejects any `add` or `aliases`. `aliases only` rejects `add`. Namespaced vocabularies grow through `<namespace>.<name>` values, not config. |
| Unknown value at run time | The adapter maps it to `other` where the vocabulary has one and keeps the native value in `ext`; otherwise the call fails. Identity and authorization fail closed. |
| Adapter declarations | A descriptor may declare additions (`vocabularies`) under the same rules. Config wins on conflict. |

## Extensions (`ext`)

`ext` is the one escape hatch for data. It replaces the old `extra`, `meta`, `metadata`, `claims` and `params` bags. The operation escape hatch, `native()`, stays.

| Rule | Detail |
| --- | --- |
| Shape | `ext?: { [key]: JSON value }`. JSON values only. |
| Keys | `<namespace>.<name>`, matching `^[a-z][a-z0-9-]*\.[A-Za-z0-9_.-]+$`. The namespace is the adapter name (`qdrant.collection`, `mcp.annotations`). |
| Reserved namespaces | `sdk`, `agent`, `run`, `model`, `tool` belong to the core. Adapters may not use them for keys or event types. |
| Who writes | The adapter that produces the shape, only keys it lists in `produces`. Mappings may write keys in the adapter's namespace. The core writes `sdk.*` keys. |
| Who reads | Any adapter, only keys it lists in `reads`. |
| Core | Copies `ext` unchanged wherever a shape passes through. Never reads, branches on, logs or traces an adapter key. |
| Telemetry | An adapter key is exported only if its producer lists it as `safe`. Secret masking still applies. |
| Size | Bounded by `limits.extBytes`. An oversized bag is dropped and an event is emitted. |
| Promotion | A key read by two or more adapters of different namespaces is a candidate for a core field in the next minor. |

A descriptor declares its keys:

```json
{ "ext": { "produces": ["qdrant.collection"], "reads": [], "safe": [] } }
```

Core-written keys:

| Key | On | Meaning |
| --- | --- | --- |
| `sdk.raw_score` | `Passage` | The source's own score, before fusion. |
| `sdk.rank` | `Passage` | Rank in its own source, starting at 1. |
| `sdk.approval` | `ToolResult` | Approval id, set when a governed call is waiting for a person. |
| `sdk.data_dropped` | `ToolResult` | `true` when a `tool_result` guard redacted the structured `data` into text that is no longer JSON, so `data` was dropped. |
| `sdk.outcome` | `ToolResult` | How a governed tool call ended: `ok`, `error`, `denied`, `blocked`, `redacted` or `pending`; the same value as the `agent.tool.outcome` attribute. |

The namespaces `sdk`, `agent`, `run`, `model` and `tool` are reserved for the core: adapters use none of them for `ext` keys or event types.

Conformance suites include `checkExt`: it fails when an adapter writes a key that is not namespaced, not declared, or in another adapter's namespace.

## Mappings

A mapping says how a standard's document becomes a language shape (`in`) or how a shape becomes a standard's document (`out`), beyond the adapter's built-in translation. The core never applies mappings in its own logic. It hands each adapter its rules through `AdapterContext.mappings`, and the adapter calls `mappings.in(native, shape)` or `mappings.out(shape, wire)` where it translates.

### Where they live

A top-level `mappings` block, also allowed under `profiles.<name>.mappings`:

```json
{ "mappings": { "<instance key>": { "in": [ ...rules ], "out": [ ...rules ] } } }
```

| Slot kind | Key | Example |
| --- | --- | --- |
| single slot | `<slot>` | `identity`, `authorization` |
| keyed slot | `<slot>.<instance>` | `tools.crm`, `knowledge.handbook` |
| list slot | `<slot>.<name>` | `guardrails.pii` |

A profile's list for a key replaces the base list; `null` removes it.

Each adapter publishes its built-in translation in its descriptor, so the effective rules are always readable:

```json
{ "mappingDefaults": { "in": { "shape": "Caller", "rules": [] }, "out": { "shape": "AccessQuestion", "rules": [] } } }
```

`in` and `out` are each optional; `rules` is optional. A list in config replaces the defaults. To add to them, use `{ "$merge": "append", "items": [ ...rules ] }`.

### Rules

Rules run in order. For `in`, the source is the native document (read-only) and the target is the shape the adapter built. For `out`, the source is the shape and the target is the wire document.

| Field | Meaning |
| --- | --- |
| `from` | JSON Pointer into the source, or a list of pointers (for `join`). Omit for a constant. |
| `to` | JSON Pointer into the target. Writing a path copies; copying then dropping the old path renames. |
| `default` | Value written when `from` is missing or null. Final: it is a target value, never `split` or looked up in `map`. |
| `map` | Value table `{ "<source value>": <target value>, "*": <fallback> }`. Keys are the source scalar as a string. A value the table does not list, without `"*"`, is not written (and is dropped from a list). |
| `join` | `"union"` concatenates lists without duplicates; a string joins strings with that separator. |
| `split` | Separator that turns a string into a list. |
| `drop` | JSON Pointer removed from the target. |
| `fn` | `"<module>#<export>"`: `(source, target, ctx) => target`, synchronous and pure. For anything the rules cannot say. |

Checked when the config loads:

| Check | Detail |
| --- | --- |
| Pointers | Every pointer parses. |
| `to`, `drop` | Address a field of the shape, or `/ext/<key>` in the adapter's namespace. |
| `map` | Targets are valid vocabulary values. |
| `fn` | The module loads, relative to the config file. |
| Reads | A mapping that reads `/ext/<key>` which nothing produces is an error. A declared `reads` key that nothing produces is a warning. |

In development and test profiles the mapped shape is also validated against its schema at run time. A mapping error in `identity` or `authorization` rejects the credential or denies the call.

Example: token claims to caller roles and scopes.

```json
"identity": { "in": [
  { "from": ["/realm_access/roles", "/groups"], "to": "/roles", "join": "union" },
  { "from": "/scope", "to": "/scopes", "split": " " },
  { "from": "/preferred_username", "to": "/name" },
  { "from": "/tenant", "to": "/ext/oidc.tenant" }
]}
```

## Multi-source knowledge

Scores from different sources are not comparable: a keyword score is unbounded, a vector store returns a similarity or a distance. Passages from two or more sources are merged by reciprocal rank fusion (RRF) by default.

| Topic | Rule |
| --- | --- |
| Config | `pipeline.knowledge.fusion: { method: "rrf" \| "raw", rrfK: 60, weights: { "<source>": 1 } }`. |
| Fused score | The sum over sources of `weight / (rrfK + rank)`, with `rank` starting at 1. Default `rrfK` is 60, default weight 1. |
| After fusion | `Passage.score` is the fused score. The core writes the source's own score to `ext["sdk.raw_score"]` and its rank to `ext["sdk.rank"]`. |
| Duplicates | The same `source` and `id` is kept once, at its best rank. |
| Ties | Break on rank, then source order in config, then `id`. |
| `method: "raw"` | Opt-in. Sorts by raw `score`, for owners who know their sources share one scorer. Raw score and rank still go to `ext`. |
| One source | Its order is kept. `score` and `ext` are written the same way, so consumers see one rule. |
| Knowledge as tools | One tool per source; results are not fused. |

## Telemetry naming

The port operations are unchanged. The core emits only `agent.*` names. Standard names are produced by the telemetry adapter that speaks the standard. Adapter spans and attributes use the adapter's namespace (`a2a.task.state`).

| Kind | Names |
| --- | --- |
| Spans | `agent.run`, `agent.model.call`, `agent.cache.lookup`, `agent.router.select`, `agent.tool.call`, `agent.access.check`, `agent.guard.check`, `agent.knowledge.search` |
| Event | `agent.knowledge.error` |
| Metrics | `agent.model.tokens` (attribute `agent.tokens.kind`: `input` or `output`), `agent.tool.calls`, `agent.access.decisions`, `agent.guard.actions` |
| Mandatory attribute | `agent.layer` on every span, event and metric |
| Run | `agent.run.id`, `agent.name`, `agent.run.status`, `agent.run.reason` (the stop code) |
| Model | `agent.model.requested`, `agent.model.used`, `agent.model.finish`, `agent.tokens.input`, `agent.tokens.output` |
| Tool | `agent.tool.name`, `agent.tool.source`, `agent.tool.outcome` |
| Guard | `agent.guard.name`, `agent.guard.stage`, `agent.guard.action` |
| Access | `agent.access.decision`, `agent.access.reason` |
| Cache, router, knowledge | `agent.cache.hit`, `agent.router.model`, `agent.knowledge.source`, `agent.knowledge.k`, `agent.knowledge.passages` |
| Trigger, error | `agent.trigger.kind`, `agent.error` |

`agent.tokens.*` is the safe prefix for attribute sanitising.

## Run events and stop reasons

Core events have fixed payloads. `at` is an optional ISO time on each.

| Event | Payload |
| --- | --- |
| `run.start` | `runId`, `agent` |
| `model.reply` | `turn`, `model`, `finish`, `calls` |
| `tool.call` | `id`, `tool` |
| `tool.result` | `id`, `tool`, `ok`, `durationMs?` |
| `text` | `text` |
| `run.end` | `status`, `reason?`, `usage?`, `costUsd?` |

Adapter events are named `<namespace>.<name>` (for example `reinloop.compaction`), outside the reserved namespaces. They are stored and replayed, never read by the core.

A run that does not complete carries a structured reason, required whenever `status` is not `completed`:

```json
{ "code": "guard_block", "layer": "guardrail", "by": "pii", "stage": "input", "detail": "card number in input" }
```

| Field | Meaning |
| --- | --- |
| `code` | Stop code vocabulary. The only field consumers branch on. |
| `layer` | Layer that stopped the run. |
| `by` | Instance that stopped it: a guard name, an approval adapter, a remote agent. |
| `stage` | Guard stage, for guard stops. |
| `detail` | Internal text. Never parsed. |

A run that stops for a human answer ends with status `waiting`, reason `needs_input` or `needs_auth`. For a pending approval the reason is `{ "code": "needs_input", "layer": "identity", "by": "<approval instance>", "detail": "<approval id>" }`. The governed tool result that asked for it carries `ext["sdk.approval"]`, so a runtime can end the run without parsing text. A later run in the same session (same session id, same caller) that makes the same call, same tool and same arguments, gets the decision: approved runs once, denied is refused, still pending returns the same approval id (see [ApprovalPort](ports/ApprovalPort.md)). The session carries the decision, not the conversation: `basic-runtime` and `reinloop` start each run from its input, so the follow-up message must lead the model to the same call.

## Trace context

`CallContext.trace` is `{ "parent": "<string>", "state": "<string>" }` (`state` optional). The core treats both as opaque and copies them. The telemetry adapter that wrote the value owns its format and parses it; channels copy it in and out unchanged. An invalid value makes the adapter start a new trace.
