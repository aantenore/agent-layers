# Ports

A port is the contract between the stack and one kind of backend. Every port has one page with the same sections: Purpose, Operations, Data shapes, Semantics, Errors, Escape hatch, Conformance, Version history.

## Port index

| Plane | Layer | Port | Version | Description |
| --- | --- | --- | --- | --- |
| Foundation | `infra` (L0) | [DeployPort](DeployPort.md) | 1.0.0 | Turn service specs into running endpoints |
| Foundation | `infra` (L0) | [SecretPort](SecretPort.md) | 1.0.0 | Resolve secret references |
| Model plane | `llm` (L1) | [ModelPort](ModelPort.md) | 1.0.0 | Model calls with tool calls, optionally streamed |
| Model plane | `cache` (L2) | [CachePort](CachePort.md) | 1.0.0 | Key/value cache for model replies; usable by any layer |
| Model plane | `cache` (L2) | [RouterPort](RouterPort.md) | 1.0.0 | Pick the model for a request |
| Agent plane | `harness` (L3) | [RuntimePort](RuntimePort.md) | 1.0.0 | Bind an agent spec to a runnable agent |
| Agent plane | `harness` (L3) | [StatePort](StatePort.md) | 1.0.0 | Session event log |
| Agent plane | `knowledge` (L4) | [KnowledgePort](KnowledgePort.md) | 1.0.0 | Search a knowledge source, answer with passages |
| Agent plane | `knowledge` (L4) | [MemoryPort](MemoryPort.md) | 1.0.0 | Long-term memory: remember, recall, forget |
| Agent plane | `knowledge` (L4) | [IngestionPort](IngestionPort.md) | 1.0.0 | Load, refresh and delete documents in a knowledge backend |
| Agent plane | `tool` (L5) | [ToolPort](ToolPort.md) | 1.0.0 | List and call tools |
| Control plane | `identity` (L6) | [IdentityPort](IdentityPort.md) | 1.0.0 | Verify inbound credentials into a caller |
| Control plane | `identity` (L6) | [CredentialPort](CredentialPort.md) | 1.0.0 | Outbound tokens, on behalf of a user or as the agent |
| Control plane | `identity` (L6) | [AuthorizationPort](AuthorizationPort.md) | 1.0.0 | Decide whether an action is allowed |
| Control plane | `identity` (L6) | [ApprovalPort](ApprovalPort.md) | 1.0.0 | Human approval for actions the policy marks ask |
| Control plane | `guardrail` (L7) | [GuardPort](GuardPort.md) | 1.0.0 | Allow, block or redact text at four stages |
| Experience plane | `interface` (L8) | [ChannelPort](ChannelPort.md) | 1.0.0 | Expose agents to people, apps and other agents |
| Experience plane | `interface` (L8) | [TriggerPort](TriggerPort.md) | 1.0.0 | Start runs from events and schedules |
| Insight plane | `telemetry` (L9) | [TelemetryPort](TelemetryPort.md) | 1.0.0 | Spans, events and metrics tagged with `agent.layer` |
| Insight plane | `eval` (L10) | [EvaluatorPort](EvaluatorPort.md) | 1.0.0 | Score a run of a dataset case |
| Insight plane | `eval` (L10) | [FeedbackPort](FeedbackPort.md) | 1.0.0 | User feedback attached to runs, as evaluation data |

Layer ids (`infra`, `llm`, `cache`, ...) are the stable identifiers. The `L0`-`L10` numbers are for reading only and never appear in identifiers or file names.

Where the boundary between layers is unclear, use these rules:

- Read-only retrieval of context is knowledge.
- Anything with side effects is a tool.
- Who may do what is identity.
- Whether the content is acceptable is a guardrail.

## Notation

- `name(param: Type, ...) → Type` is an operation. A trailing `?` marks an optional parameter, field or result. `[T]` is a list, `{K: V}` a map, `Any` any JSON value.
- Operations that can do I/O are asynchronous: they return a result later and may fail later. A language binding picks its own mechanism (promise, future, blocking call).
- `signal` is a cancellation signal. When it fires, the operation stops as soon as it can and fails with a cancellation error. It is never turned into a result.
- Data shapes are JSON values. Field names are as written, case included.
- Time is a string in date-time form.

## Language

The data that crosses a port is written in one language owned by this project, version 1.0: fixed shapes, vocabularies, and `ext` for what the shapes do not cover. Standards (OpenAI Chat Completions, MCP, A2A, AuthZEN, OIDC, OpenTelemetry, CloudEvents, ...) appear only inside adapters, which translate at the edges. See [the language](../language.md) for naming rules, vocabularies, `ext` and boundary mappings.

Two types are shared by many shapes ([common.json](../schemas/common.json)):

| Type | Meaning |
| --- | --- |
| `Ext` | `{String: Any}` of JSON values, optional on every shape as `ext?`. Keys are `<namespace>.<name>`; the namespace is the producing adapter's, `sdk.` is the core's. The core copies it unchanged and never reads an adapter key. |
| `Attrs` | `{String: String \| Number \| Boolean \| [String]}`: plain attributes a filter or a policy may read (owner, tags, language). |

## Common types

Every port instance may expose these members, whatever the port:

| Member | Meaning |
| --- | --- |
| `name?: String` | Instance name, for example the configuration key of a knowledge source. |
| `native?() → Any` | Escape hatch for operations: the underlying client or technology-specific API, for features the port does not cover. |
| `close?() → ()` | Release connections and flush buffers. Called once when the stack stops. |

`CallContext` is passed to the ports that act inside a run (ModelPort, RouterPort, ToolPort):

| Field | Type | Meaning |
| --- | --- | --- |
| `runId` | String | Identifier of the run. |
| `agent` | String | Name of the agent. |
| `caller?` | [Caller](../schemas/caller.json) | Who the run acts for. Absent means anonymous. Its `credential` is never logged. |
| `sessionId?` | String | Session the run belongs to. |
| `signal?` | Signal | Cancellation. |
| `telemetry?` | TelemetryPort | Where spans and events go. |
| `credentials?` | BoundCredentials | `token(audience: String, scopes?: [String]) → String`: outbound tokens already bound to the caller of this run. |
| `trace?` | `{parent: String, state?: String}` | Trace context of the request that started the run, when it carried one. Opaque to the core: the telemetry adapter that wrote the value owns its format, and channels copy it in and out unchanged. See [TelemetryPort](TelemetryPort.md). |

## Composition

The stack wires ports around each other. Adapters implement a single port and do not need to know this, but the rules below hold for every stack and are covered by the port pages.

- Model call, in order: input guards on new user content, cache lookup, router, model, cache store, output guards. The cache stores the raw model reply, so output guards also run on cache hits.
- Knowledge is injected before the model call as a delimited block marked untrusted: retrieved text is data, not instructions. Passages from several sources are fused by reciprocal rank (`k = 60` by default) because scores of different sources are not comparable; knowledge exposed as tools is not fused.
- Tool call, in order: local policy, approval (for `ask`), authorization, `tool_args` guards, the call with bound credentials, `tool_result` guards. Denials and blocks come back as tool results with `ok: false` and a `text` the model can read, tagged `ext["sdk.outcome"]`.
- Guards of one stage run in order. A guard that fails counts as a block (fail closed).
- Every span, event and metric carries `agent.layer`, and the core names its own with `agent.*` only. Attributes whose key looks like a secret are masked.

## Conformance

Each port has a conformance suite in `packages/conformance`. Suites collect failures and skipped checks and never abort on the first failure. The page of each port lists what its suite checks. Every suite also runs `checkExt`: the `ext` keys an adapter writes must be namespaced, in its own namespace and declared in its descriptor.
