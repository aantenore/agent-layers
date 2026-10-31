# agent-layers

agent-layers composes the eleven layers an agent needs, from a laptop prototype to production: infrastructure,
models, model access, runtime, knowledge, tools, identity, guardrails, interfaces, telemetry and evaluation.

It does not implement any of them. The core defines a port for each layer; adapters map an open standard, or a
technology's native API, onto a port; a stack config picks one adapter per port, per profile. The agent runtime is
an adapter too, so it can be replaced like anything else.

- **Why it exists and how it compares:** [docs/product.md](docs/product.md)
- **How it works:** [docs/architecture.md](docs/architecture.md)
- **The layers on one page:** [docs/stack.md](docs/stack.md)
- **Start a project, write an adapter, go to production:** [docs/guide.md](docs/guide.md)
- **Adapters, status and maturity:** [docs/adapters.md](docs/adapters.md)
- **The language-neutral spec:** [spec/](spec/README.md)

## Principle

**Product first, standards adapt.** Ports are designed from what a developer building and shipping an agent needs to
call. Standards and technologies appear only as adapters. A new technology is an adapter plus its conformance test,
never a core change.

## The eleven layers

| Plane | L | Layer (id) | The question it answers |
|---|---|---|---|
| Foundation | L0 | Infrastructure & delivery (`infra`) | Where does it run and how does it get there? |
| Model | L1 | Models (`llm`) | Who thinks? |
| Model | L2 | Model access (`cache`) | Which model, at what cost and latency? |
| Agent | L3 | Agent runtime (`harness`) | How does the agent loop run and keep state? |
| Agent | L4 | Knowledge & memory (`knowledge`) | What does it know? |
| Agent | L5 | Tools (`tool`) | What can it do? |
| Control | L6 | Identity & access (`identity`) | Who is it, on whose behalf, and what is allowed? |
| Control | L7 | Guardrails (`guardrail`) | Is this content acceptable? |
| Experience | L8 | Interfaces, channels & triggers (`interface`) | Who talks to it and what starts it? |
| Insight | L9 | Telemetry & observability (`telemetry`) | What happened? |
| Insight | L10 | Evaluation & improvement (`eval`) | Was it good, and if not, which layer failed? |

Ports per layer, reference adapters and the request flow are in [docs/stack.md](docs/stack.md).

## Quickstart

Requirements: Node >= 22.18. Docker and a local model server are optional (the `local` profile and the reference
setups use them).

```bash
git clone https://github.com/aantenore/agent-layers && cd agent-layers
npm install

cd examples/minimal
node --conditions=source ../../packages/cli/src/cli.ts check      # config, adapters, readiness, conformance
node --conditions=source ../../packages/cli/src/cli.ts dev        # talk to the agent, one trace line per layer
node --conditions=source --test "tests/**/*.test.ts"              # smoke dataset, offline
node --conditions=source ../../packages/cli/src/cli.ts diff prototype production
```

Once the packages are published the same commands are `npx agent-layers init my-agent`, then `check`, `dev`,
`test`, `eval` and `deploy --profile production`. `examples/minimal` is what `init` generates: all eleven layers
wired, a prototype profile on zero-dependency adapters, and pilot and production profiles that name the reference
adapters.

## Layout

```
spec/            language-neutral source of truth: schemas/, ports/, VERSIONING.md
packages/core    @agent-layers/core: ports, adapter registry, pipelines, stack config, compose (zero dependencies)
packages/conformance  @agent-layers/conformance: one suite per port
packages/cli     @agent-layers/cli: init, dev, check, test, eval, deploy, diff, layers
adapters/<name>  @agent-layers/adapter-<name>: one package per standard or technology; _template to start one
examples/        sample projects (minimal)
reference/<id>/  reference setups per layer: compose files and live tests (today under layers/)
docs/            product, architecture, stack, guide, adapters, layers/<id>.md, cross-cutting/
```

## Development

```bash
npm install                                          # workspaces, dev dependencies only
npx tsc -p packages/core && npx tsc -p packages/cli  # typecheck one package
npm test -w @agent-layers/core                       # tests of one package
make test LAYER=l3-knowledge                         # live test of one reference setup
```

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Core paths need a spec change first.

## Licenses of the reference technologies

This repository is MIT. Reference technologies are used as separate processes or services through adapters, never vendored.

| Component | License | Layer (id) |
|---|---|---|
| reinloop | MIT | harness |
| Ollama | MIT | llm |
| Qdrant | Apache-2.0 | knowledge |
| Apache Jena Fuseki | Apache-2.0 | knowledge (next) |
| MCP Toolbox for Databases | Apache-2.0 | knowledge (next) |
| mcp-server-qdrant | Apache-2.0 | knowledge |
| Docling | MIT | knowledge (docs) |
| Graphiti | Apache-2.0 | knowledge (optional) |
| LightRAG | MIT | knowledge (optional) |
| go-httpbin | MIT | tool |
| Keycloak | Apache-2.0 | identity |
| OPA | Apache-2.0 | identity |
| Presidio | MIT | guardrail |
| LLM Guard | MIT | guardrail |
| LiteLLM | MIT core (the `enterprise/` directory is under a separate commercial license and is not used) | cache |
| Valkey | BSD-3-Clause | cache |
| OpenTelemetry Collector | Apache-2.0 | telemetry |
| Langfuse | MIT core (the `ee/` directories are under a separate commercial license and are not used) | telemetry |
| Jaeger | Apache-2.0 | telemetry |
| promptfoo | MIT | eval |
| Docker Compose | Apache-2.0 | infra |
| Traefik | MIT | infra (docs) |
| Argo CD | Apache-2.0 | infra (docs) |
| OpenTofu | MPL-2.0 | infra (docs) |
| OpenBao | MPL-2.0 | infra (docs) |
| LibreChat | MIT | interface (planned) |
| A2A | Apache-2.0 | interface (planned) |
| AG-UI | MIT | interface (planned) |

All of the above are OSI-approved licenses (for the split-licensed projects, only the open-source parts are used).
Phoenix (Elastic License 2.0) and Llama Guard (Llama Community License) are deliberately excluded because their
licenses are not OSI-approved.

Model weights are licensed separately from the tools that serve them. The default `qwen3:4b` is Apache-2.0
(`qwen2.5:3b`, for comparison, is under the Qwen Research License, which is not OSI-approved). Check the license of
the model you ship. `LLM_MODEL` can point to any model Ollama serves.

## License

MIT. See [LICENSE](LICENSE).
