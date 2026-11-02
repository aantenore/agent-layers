# @agent-layers/adapters

Every adapter of [agent-layers](https://github.com/aantenore/agent-layers) in one package: one subpath export per
standard or technology, released together with `@agent-layers/core`.

```bash
npm install @agent-layers/core @agent-layers/adapters
```

A stack config names an adapter by its subpath (`"adapter": "mock-model"`); the core loads
`@agent-layers/adapters/<name>` on first use, so only the adapters a stack uses are imported. In code:

```ts
import { adapter as mockModel } from '@agent-layers/adapters/mock-model';
import { createSqliteStore } from '@agent-layers/adapters/sqlite-store';
```

Most adapters have no runtime dependencies beyond `@agent-layers/core`. `reinloop` needs the `reinloop` package, an
optional peer dependency: `npm install reinloop` to use it.

Before 0.4.0 each adapter was a package of its own, `@agent-layers/adapter-<name>`; it is now
`@agent-layers/adapters/<name>`, with the same exports.

| Subpath | Port | Maps |
|---|---|---|
| [`a2a`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/a2a#readme) | ChannelPort, RuntimePort | Agent2Agent (A2A) protocol |
| [`authzen`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/authzen#readme) | AuthorizationPort | OpenID AuthZEN |
| [`basic-runtime`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/basic-runtime#readme) | RuntimePort | in-process tool-calling loop |
| [`cloudevents`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/cloudevents#readme) | TriggerPort | CloudEvents 1.0 HTTP binding |
| [`compose-deploy`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/compose-deploy#readme) | DeployPort | Compose Specification |
| [`console-telemetry`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/console-telemetry#readme) | TelemetryPort | terminal output |
| [`cron-trigger`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/cron-trigger#readme) | TriggerPort | in-process timers (interval or cron expression) |
| [`expected-eval`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/expected-eval#readme) | EvaluatorPort | expected answers |
| [`functions`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/functions#readme) | ToolPort | JavaScript functions |
| [`http-guard`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/http-guard#readme) | GuardPort | agent-layers guard HTTP contract |
| [`http-knowledge`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/http-knowledge#readme) | KnowledgePort | agent-layers knowledge HTTP contract |
| [`http-tools`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/http-tools#readme) | ToolPort | HTTP/JSON |
| [`jsonl-telemetry`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/jsonl-telemetry#readme) | TelemetryPort | JSON Lines files |
| [`judge-eval`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/judge-eval#readme) | EvaluatorPort | LLM as judge |
| [`layer-signals`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/layer-signals#readme) | EvaluatorPort | per-layer signals from run events and telemetry |
| [`llm-guard`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/llm-guard#readme) | GuardPort | LLM Guard |
| [`markdown-knowledge`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/markdown-knowledge#readme) | KnowledgePort | Markdown files |
| [`mcp`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/mcp#readme) | ToolPort, KnowledgePort, ChannelPort | Model Context Protocol |
| [`memory-approval`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/memory-approval#readme) | ApprovalPort | in-process store |
| [`memory-cache`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/memory-cache#readme) | CachePort | in-process Map |
| [`memory-state`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/memory-state#readme) | StatePort | in-process Map |
| [`memory-store`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/memory-store#readme) | StorePort | in-process Map |
| [`mock-model`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/mock-model#readme) | ModelPort | scripted deterministic model |
| [`oidc`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/oidc#readme) | IdentityPort, CredentialPort | OpenID Connect / OAuth 2.0 (RFC 7519, RFC 8693) |
| [`opa`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/opa#readme) | AuthorizationPort | Open Policy Agent |
| [`openai-compatible`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/openai-compatible#readme) | ModelPort, ChannelPort | OpenAI Chat Completions |
| [`openapi`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/openapi#readme) | ToolPort | OpenAPI 3 |
| [`otlp`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/otlp#readme) | TelemetryPort | OpenTelemetry OTLP/HTTP + GenAI semantic conventions |
| [`presidio`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/presidio#readme) | GuardPort | Microsoft Presidio |
| [`regex-guard`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/regex-guard#readme) | GuardPort | regular expressions |
| [`reinloop`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/reinloop#readme) | RuntimePort | reinloop |
| [`rule-router`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/rule-router#readme) | RouterPort | local routing rules |
| [`rules-authorization`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/rules-authorization#readme) | AuthorizationPort | local rule list |
| [`sqlite-approval`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/sqlite-approval#readme) | ApprovalPort | SQLite |
| [`sqlite-state`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/sqlite-state#readme) | StatePort | SQLite |
| [`sqlite-store`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/sqlite-store#readme) | StorePort | SQLite |
| [`static-identity`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/static-identity#readme) | IdentityPort, CredentialPort | static token table (development only) |
| [`static-router`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/static-router#readme) | RouterPort | static model mapping |
| [`terminal-channel`](https://github.com/aantenore/agent-layers/tree/main/packages/adapters/src/terminal-channel#readme) | ChannelPort | terminal (stdin/stdout) |

Tiers, directions and maturity of each adapter are in the
[adapter catalog](https://github.com/aantenore/agent-layers/blob/main/docs/adapters.md#available).

Requires Node >= 22.18. License: MIT.
