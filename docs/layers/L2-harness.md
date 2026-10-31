# L2 Agent runtime

## Responsibility

Run the agent loop: prompts, tool calls, policy and approvals, budgets, durability, compaction and multi-agent
patterns. Everything above the model and below the interface.

L2 is a **runtime contract**. agent-layers is the container; the runtime is one component that fills this slot, and
it is swappable like every other reference. [reinloop](https://github.com/aantenore/reinloop) is the first binding
(the reference runtime). LangGraph, Pydantic AI, the OpenAI Agents SDK and Google ADK are candidate runtimes.

## Standard

- Markdown agent files with the common subagent frontmatter (`name`, `description`, `tools`, `model`).
- Agent Skills (`SKILL.md` folders).
- MCP server exposure: every agent and team can be served as an MCP tool (`reinloop mcp`).
- CloudEvents (HTTP binding) for event triggers.

## Extension point

Middleware (`beforeModel`, `afterModel`, `beforeTool`, `afterTool`), multi-agent patterns, `RunStore`, and plugins
that register providers, tools, stores, sinks and caches by name. Layers L3, L5, L6 and L7 attach to the runtime
through these hooks.

## Reference implementation

[reinloop](https://github.com/aantenore/reinloop) (MIT), the first runtime binding.

```bash
reinloop serve --port 8700     # HTTP + SSE API (REINLOOP_SERVE_PORT)
reinloop mcp                   # agents as MCP tools
```

## Adapter SDK + conformance

Not needed for the agent format: it is a standard. A different runtime is conformant if it reads the same agent
files, calls the same tools and emits the same events and spans. `RunStore` is the one interface to implement when
you want runs and sessions in another database.

### Runtimes folder (planned)

Each runtime gets `runtimes/<name>/` holding **only configuration and the binding** to the layer contracts. The
runtime itself comes in as a versioned dependency (npm, PyPI, container image); its source is never vendored into this
repository. Today the reinloop wiring lives in `layers/l2-harness/`; it will move to `runtimes/reinloop/` when a
second runtime is added.

## Around the layer

- **Session state.** A Postgres-backed `RunStore` keeps runs and sessions across restarts and replicas.
- **Workers, queues and scheduled triggers.** Runs can start from an event or a schedule, not only from a user
  message. Triggers arrive as CloudEvents over HTTP (see the contract below).
- **Know-how as Skills.** Procedures an agent should follow live in Agent Skills: files in git, loaded on demand,
  versioned with the agent.
- **Budgets.** Per-run limits on tokens, tool calls and spend; see [cost](../cross-cutting/cost.md).

## How to swap it

The other layers talk to the runtime through standard formats: agent files, MCP, HTTP/SSE, CloudEvents and OTLP. A
different runtime that reads the same agent files, calls the same tools and emits the same spans can replace
reinloop. What a runtime must provide for each layer is described in the layer docs.

## Contract

- In: agent file + input (+ identity), or a CloudEvent.
- Out: a `RunEvent` stream ending in `run_end { status, output, usage, costUsd }`.
- HTTP: `reinloop serve`, port 8700.
- Triggers: CloudEvents HTTP binding to `POST /v1/events`; answered `202` with a `runId`.

Details in [contracts.md](../contracts.md#l2-agent-runtime).

## How to test

```bash
make test LAYER=l2-harness
```

Live test: loads `layers/l2-harness/agents/assistant.md`, runs it against Ollama (`LLM_BASE_URL`, `LLM_MODEL`) and
asserts a completed run with non-empty output. Skips with a message if Ollama or the model is unavailable.
