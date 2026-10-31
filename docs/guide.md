# Guide

How to start a project, write an adapter, write a runtime adapter, configure a stack, and promote it from prototype
to production. Concepts are in [architecture.md](architecture.md).

## Quickstart: init and start developing

```bash
npx agent-layers init my-agent          # --template minimal|rag, --runtime <adapter>, --name, --agent, --force
cd my-agent && npm install
npx agent-layers check                  # config, adapters, readiness gate, conformance (prototype profile)
npx agent-layers dev                    # talk to the agent, one trace line per layer
npm test                                # the smoke dataset, offline, with a scripted model
npx agent-layers eval evals/smoke.jsonl --agent assistant
npx agent-layers dev --profile local    # same stack with a real model on this machine
npx agent-layers layers                 # every layer, its ports, the adapter in use and those installed
npx agent-layers gateway                # the same stack on http://127.0.0.1:8787 for any language (Bearer dev-token)
```

`init` writes a project with all eleven layers wired: `agent-layers.json` (profiles `prototype`, `test`, `local`,
`pilot`, `production`), the agent in `agents/<name>.md`, a function tool in `tools/`, Markdown pages in `knowledge/`,
`evals/smoke.jsonl`, `tests/agent.test.ts`, `.env.example` and a README that maps every layer to its adapter per
profile. The prototype profile uses only zero-dependency adapters, so it runs anywhere. `examples/minimal` is the
same template, generated.

Inside this repository, use `node --conditions=source packages/cli/src/cli.ts <command>` instead of `npx`.

## Concepts in one paragraph each

- **Layer**: one of eleven concerns, with a stable id (`knowledge`). Each answers one question.
- **Port**: the interface for a layer's job (`KnowledgePort.search → Passage[]`), versioned with semver.
- **Adapter**: maps a standard or a technology's native API onto a port. A descriptor declares layer, port,
  direction, what it maps, port version, tiers and an options schema.
- **Slot**: a key under `layers` in the config. Each slot fills one port with one adapter, a keyed set
  (`knowledge`, `tools`, `ingestion`) or a list (`guardrails`, `telemetry`, `eval`, `channels`, `triggers`).
- **Pipeline**: the glue between ports: `guardedModel`, `knowledgeInjector`, `governedTools`.
- **Stack**: what `compose(config)` returns: the instances, the composed model and tools, the agents, `close()`.
- **Runtime adapter**: a RuntimePort; binds an agent spec to a runnable agent on top of the stack.
- **Conformance**: a suite per port (`@agent-layers/conformance`) that proves an adapter behaves.

## Write an adapter

An adapter is a package `@agent-layers/adapter-<name>` with a factory and a descriptor. A guard that blocks a list of
words:

```ts
import { defineAdapter, PORT_VERSIONS, type GuardPort } from '@agent-layers/core';

export function createWordGuard(options: { words: string[] }, name = 'word-guard'): GuardPort {
  const words = options.words.map((w) => w.toLowerCase());
  return {
    name,
    async check(check) {
      const hit = words.find((w) => check.text.toLowerCase().includes(w));
      return hit ? { action: 'block', labels: ['policy'], reason: `contains "${hit}"` } : { action: 'allow' };
    },
  };
}

export const adapter = defineAdapter<'GuardPort', { words: string[] }>({
  layer: 'guardrail', port: 'GuardPort', name: 'word-guard', direction: 'outbound',
  maps: { technology: 'word list' }, portVersion: PORT_VERSIONS.GuardPort, tiers: ['prototype'],
  optionsSchema: { type: 'object', properties: { words: { type: 'array', items: { type: 'string' } } }, required: ['words'] },
  create: (options, ctx) => createWordGuard(options, ctx.name),
});
export const adapters = [adapter];
```

And its conformance test:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

test('word-guard passes GuardPort conformance', async () => {
  const report = await checkAdapter(adapter, { options: { words: ['forbidden'] }, fixtures: { block: [{ stage: 'input', text: 'this is forbidden' }] } });
  assert.deepEqual(report.failures, []);
});
```

Start from [`adapters/_template`](../adapters/_template); [CONTRIBUTING.md](../CONTRIBUTING.md) has the checklist.
Rules:

- Name the package after the standard or technology it maps. If it speaks a standard, set `maps.standard`;
  otherwise `maps.technology`.
- Translate at the edge. Your standard's names stay inside the adapter; what crosses the port is the SDK language
  ([spec/language.md](../spec/language.md): `ModelRequest`, `ToolResult`, `Caller`, `GuardCheck`, ...).
- Errors that the model should see are results (`ok: false`, `block`), not exceptions; authorization fails closed.
- Never put tokens or secrets in errors, logs or telemetry attributes.
- Put technology-specific data in `ext` (keys `<adapter>.<name>`) and operations behind `native()`.
- `portVersion` is `1.0.0` for every port.
- `tiers: ['prototype']` for in-memory, scripted or development-only adapters; `production` when backed by a real
  system that can run in production.

### Declare `ext`, vocabularies and mappings

The descriptor says what the adapter adds to the language and how it translates:

```ts
export const adapter = defineAdapter<'KnowledgePort', Options>({
  layer: 'knowledge', port: 'KnowledgePort', name: 'qdrant', direction: 'outbound',
  maps: { technology: 'Qdrant' }, portVersion: PORT_VERSIONS.KnowledgePort, tiers: ['production'],
  optionsSchema,
  ext: { produces: ['qdrant.collection'], reads: [], safe: ['qdrant.collection'] },
  vocabularies: { guardLabel: { add: { 'pii.health': { like: 'pii' } } } },
  mappingDefaults: {
    in: { shape: 'Passage', rules: [{ from: '/payload/title', to: '/title' }] },
    out: { shape: 'KnowledgeQuery' },
  },
  create: (options, ctx) => createQdrant(options, ctx),
});
```

| Descriptor field | Meaning |
|---|---|
| `ext` | `produces`: the `ext` keys the adapter writes, in its own namespace (the adapter name). `reads`: keys of other namespaces it reads. `safe`: produced keys telemetry may export. The core never reads an adapter key. |
| `vocabularies` | Values the adapter adds to extensible vocabularies (`risk`, `finish`, `guardLabel`, ...), each `like` a core value. Config wins on conflict. |
| `mappingDefaults` | `{ in?: { shape, rules? }, out?: { shape, rules? } }`: the shape each direction builds and the adapter's built-in translation as rules, so the effective rules are readable. A direction left out takes no rules from config. |

Where the adapter translates, apply the rules that the stack config may have replaced or extended:

```ts
create: (options, ctx) => ({
  async search(query) {
    const hits = await client.search(ctx.mappings.out(query, { text: query.text }));
    // The built-in translation builds the shape; the rules then read the native hit and adjust it.
    return hits.map((hit) => ctx.mappings.in(hit, { id: String(hit.id), text: hit.payload.text, source: ctx.name, score: hit.score }));
  },
}),
```

`ctx.mappings.in(native, shape)` turns a standard's document into a language shape; `ctx.mappings.out(shape, wire)`
turns a shape into the standard's document. Both are free when no rules apply. Config, not code, changes them
([stack.md](stack.md#vocabularies-and-mappings)).

Conformance proves the declaration: the suite of the port runs `checkExt` (every `ext` key the adapter writes is
namespaced, in its namespace and listed in `produces`), and `roundTrip` checks an adapter's own translation:

```ts
import { checkExt, roundTrip } from '@agent-layers/conformance';

assert.deepEqual(checkExt(adapter, passage), []);
assert.deepEqual(roundTrip(samples, toLanguage, toStandard, { shape: 'Passage' }), []);   // standard -> language -> standard
```

Telemetry adapters that keep trace ids pass a `TraceCodec` (`parse` / `format` for the format they speak, for example
W3C Trace Context) to `recordingTelemetry(write, name, { trace: codec })`. The core treats `CallContext.trace`
(`{ parent, state? }`) as opaque.

Many technologies need no adapter of their own because they speak a standard: Keycloak, Entra ID or any identity
provider through OIDC; Ollama, vLLM, LiteLLM or a hosted API through `openai-compatible`; Langfuse, Jaeger or any
collector through OTLP.

## Write a runtime adapter

A runtime adapter is a RuntimePort. It receives the composed `Stack` and an `AgentSpec`, and returns an agent whose
`run` uses `stack.modelFor(agent)` and `stack.toolsFor(agent)`; guards, cache, routing, knowledge, authorization,
credentials and telemetry are already applied there.

```ts
import { callsOf, defineAdapter, messageText, PORT_VERSIONS, textMessage, toolInfos, type Message, type RuntimePort } from '@agent-layers/core';

const loop: RuntimePort = {
  bind: (stack, agent) => ({
    name: agent.name,
    async run(input, init = {}) {
      const ctx = stack.context({ ...init, agent: agent.name });
      const model = stack.modelFor(agent);
      const tools = stack.toolsFor(agent);
      const specs = await tools.listTools(ctx);
      const messages: Message[] = [textMessage('system', agent.instructions), textMessage('user', String(input))];
      for (let turn = 0; turn < 8; turn++) {
        const { message } = await model.chat({ model: agent.model, messages, tools: toolInfos(specs), settings: agent.settings }, ctx);
        messages.push(message);
        const calls = callsOf(message);
        if (!calls.length) return { runId: ctx.runId, status: 'completed', output: messageText(message) };
        const parts = [];
        for (const call of calls) {
          const out = await tools.callTool(call.tool, call.args, ctx);
          parts.push({ type: 'result' as const, callId: call.id, ok: out.ok, text: out.text });
        }
        messages.push({ role: 'tool', parts });
      }
      return { runId: ctx.runId, status: 'stopped', output: '', reason: { code: 'limit', layer: 'harness', detail: 'max turns' } };
    },
  }),
};

export const adapter = defineAdapter({
  layer: 'harness', port: 'RuntimePort', name: 'my-loop', direction: 'outbound', maps: { technology: 'my loop' },
  portVersion: PORT_VERSIONS.RuntimePort, tiers: ['prototype'], optionsSchema: { type: 'object' }, create: () => loop,
});
```

The stack wraps every run in an `agent.run` span, turns a guardrail block into status `stopped` with reason code
`guard_block`, and appends the returned events (`run.start`, `model.reply`, `tool.call`, `tool.result`, `text`,
`run.end`) to the state slot when the call carries a `sessionId`. A runtime written in another language plugs
in as a remote runtime (the `a2a` adapter) or uses the gateway's OpenAI-compatible and MCP endpoints; see
[gateway.md](gateway.md#a-runtime-in-another-language).

## Stack config reference

`agent-layers.json`, schema [`spec/schemas/stack-config.json`](../spec/schemas/stack-config.json) (also
`@agent-layers/core/schema.json`).

| Key | Meaning |
|---|---|
| `name` | Project name |
| `plugins` | Modules that export adapter descriptors, for adapters outside `@agent-layers/adapter-*` |
| `profile` | Default profile; `--profile` or `AGENT_LAYERS_PROFILE` override it |
| `layers` | Base slots shared by all profiles |
| `profiles.<name>` | `extends`, `tier`, `requires`, `layers` (only what differs), `policy`, `pipeline`, `gateway`, `limits`, `vocabularies`, `mappings`, `description` |
| `policy` | Local authorization rules `{ effect: allow\|ask\|deny, tools?, risk?, when?: { roles, scopes, kind, authenticated } }`, first match wins; `authenticated: true` matches any verified caller, `false` only an anonymous one |
| `pipeline.knowledge` | `k`, `maxChars`, `maxK`, `mode`: `system` (default), `user`, `tools` (expose sources as tools), `off`; `fusion` (how several sources merge, see [stack.md](stack.md#knowledge-fusion)) |
| `pipeline.cacheTtlMs`, `pipeline.cacheScope`, `pipeline.approvalTimeoutMs` | Cache lifetime; who shares a cached answer (`caller` by default, or `shared`); how long a tool call waits for an approval |
| `gateway` | Network host: `port`, `host`, `inbound` (channel and trigger names to mount), `anonymous`, `publicOrigin`, `cors`, `allowedOrigins`, `allowedHosts`, and its limits (`maxBodyBytes`, `requestTimeoutMs`, ...); see [gateway.md](gateway.md) |
| `vocabularies` | Values and aliases added to extensible vocabularies; see [stack.md](stack.md#vocabularies-and-mappings) |
| `mappings` | Boundary mapping rules per adapter instance; see [stack.md](stack.md#vocabularies-and-mappings) |
| `limits.check`, `limits.extBytes` | Time limits of the `check` probes; size of the `ext` bags the core keeps. Every limit, adapters included, with defaults and safe ranges: [limits.md](limits.md) |
| `agents.<name>` | `file` (Markdown with front matter `model`, `tools`, `knowledge`; body = instructions) or inline `instructions`, `model`, `tools`, `knowledge`, `settings` (`temperature`, `maxOutputTokens`, `stop`), `ext`. `params` was removed at 1.0 |

Slots under `layers`:

| Slot | Port | Shape |
|---|---|---|
| `deploy`, `secrets` | DeployPort, SecretPort | single |
| `model` | ModelPort | single |
| `router`, `cache` | RouterPort, CachePort | single |
| `runtime`, `state` | RuntimePort, StatePort | single |
| `knowledge`, `ingestion` | KnowledgePort, IngestionPort | keyed by source name |
| `memory` | MemoryPort | single |
| `tools` | ToolPort | keyed by source name (tool names become `<source>__<tool>`; no source name may start with another one followed by `__`) |
| `identity`, `credentials`, `authorization`, `approval` | IdentityPort, CredentialPort, AuthorizationPort, ApprovalPort | single |
| `guardrails` | GuardPort | list; each entry may set `stages` |
| `channels`, `triggers` | ChannelPort, TriggerPort | list |
| `telemetry` | TelemetryPort | list |
| `eval` | EvaluatorPort | list |
| `feedback` | FeedbackPort | single |

Each entry is `{ "adapter": "<name>", "options": { ... } }`. Strings may use `${env:NAME}` and
`${env:NAME:-default}` (resolved for the selected profile only; the CLI also reads `.env`) and `${secret:NAME}`
(resolved through the `secrets` slot when the stack is composed).

## From prototype to production

The promise: the agent spec, the tools and the tests never change; only the layers that move to enterprise systems
do, one at a time, in config.

**The ladder.** Profiles extend each other and list only the slots that differ:

```json
"profiles": {
  "prototype":  { "tier": "prototype", "layers": { "...": "every slot, zero-dependency adapters" } },
  "pilot":      { "extends": "prototype", "layers": { "telemetry": [{ "adapter": "otlp" }], "knowledge": { "docs": { "adapter": "qdrant" } } } },
  "production": { "extends": "pilot", "tier": "production", "layers": { "identity": { "adapter": "oidc" }, "authorization": { "adapter": "opa" } } }
}
```

Resolution deep-merges along the chain. Single slots and keyed entries merge when the adapter stays the same (so an
overlay can change options only) and are replaced when it changes. Lists replace by default; write
`{ "$merge": "append", "items": [...] }` to add to the inherited list. `null` removes a slot.

**One layer at a time.** Install the adapter for the target system, set it in the next profile up, run
`agent-layers diff pilot production` to see what moves, and `agent-layers check --profile production` to prove it.
Adapters that are named but not installed are reported as "not installed", not as a crash.

**The readiness gate.** Adapters declare `tiers`; profiles declare `tier`. `check` fails when a production-tier
profile uses a prototype-only adapter, or lacks a required slot. The required set is `requires` on the profile;
the default for the production tier is identity, authorization, guardrails, telemetry and state. It also fails a
limit set to `"unbounded"` where that is unsafe (request bodies, responses, timeouts, sessions) and warns for values
outside the safe range; see [limits.md](limits.md).
Conformance probes run against the live services. A credentials adapter that issues tokens only on behalf of a caller
(`oidc` in `on-behalf-of` mode) needs one: pass `--token <caller token>` (or `AGENT_LAYERS_TOKEN`); the token is verified
through the identity adapter and the probe exchanges it. Without a caller the probe is reported as `skip`, not as a failure.

**Promotion is configuration, not code.** Most enterprise moves are standard adapters pointed at systems the
company already runs: the corporate identity provider through OIDC, corporate observability through OTLP, the
corporate model gateway through an OpenAI-compatible URL. Then `agent-layers deploy --profile production`.

## CLI

| Command | What it does |
|---|---|
| `init [dir]` | Scaffold a project (`--template minimal\|rag`; `tools` and `multi-agent` are planned) |
| `dev` | Compose the profile, start reference services through the deploy slot if needed, talk to the agent; `--message` runs once |
| `check [--token t]` | Validate config, resolve adapters, readiness gate, conformance on every configured adapter (as the caller `t` where a probe needs one) |
| `test [--layer id]` | `check`, then the reference live tests (`reference/<id>/test`) and the project's `tests/` |
| `eval <dataset> --agent X` | Run and score a JSON Lines dataset (`--out`, `--min`) |
| `deploy` / `up` / `down` | Plan, start and stop services through the deploy slot (`--dry-run`) |
| `diff <a> <b>` | Per slot: same, changed, added, removed |
| `layers` | The eleven layers by plane: ports and versions, adapter in use, installed adapters (standard and native) |
| `gateway` | Host the profile on the network ([gateway.md](gateway.md)): mounted channels and triggers on one address, every request authenticated through the identity slot; `--port`, `--host`; a production-tier profile must pass the readiness gate |

`dev`, `eval` and `test` run as an authenticated caller. The credential comes from `--token <t>`, then the
`AGENT_LAYERS_TOKEN` environment variable, then (prototype-tier profiles only) the first token of the `static-identity`
adapter in the identity slot. It is verified through the identity slot and passed to every run; a rejected credential
stops the command with no run, and the credential is never printed. Without an identity adapter or a credential the run is
anonymous, which rules-based authorization denies.

## Extension rules

1. A new technology is an adapter plus its conformance test, never a core change.
2. A core change starts with the spec: the port page, its schema, a version bump ([VERSIONING](../spec/VERSIONING.md)).
3. Adapters depend on `@agent-layers/core` as a peer and test with `@agent-layers/conformance`.
4. Technology and standard names appear in adapters and reference setups only; the core speaks one language
   ([spec/language.md](../spec/language.md), [ADR 0001](decisions/0001-sdk-language.md)).
5. Extra data goes in namespaced `ext` keys declared in the descriptor, never in a new field.
