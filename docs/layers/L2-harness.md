# L2 Harness

## Purpose

Run the agent loop: prompts, tool calls, policy and approvals, budgets, durability, compaction and multi-agent
patterns. Everything above the model and below the interface.

## Standard

- Markdown agent files with the common subagent frontmatter (`name`, `description`, `tools`, `model`).
- Agent Skills (`SKILL.md` folders).
- MCP server exposure: every agent and team can be served as an MCP tool (`reinloop mcp`).

## Extension point

Middleware (`beforeModel`, `afterModel`, `beforeTool`, `afterTool`), multi-agent patterns, and plugins that register
providers, tools, stores, sinks and caches by name. Layers L3, L5, L6 and L7 attach to the harness through these hooks.

## Reference implementation

[reinloop](https://github.com/aantenore/reinloop) (MIT).

```bash
reinloop serve --port 8700     # HTTP + SSE API (REINLOOP_SERVE_PORT)
reinloop mcp                   # agents as MCP tools
```

## How to swap it

The other layers talk to the harness through standard formats: agent files, MCP, HTTP/SSE and OTLP. A different
runtime that reads the same agent files, calls the same tools and emits the same spans can replace reinloop. What a
runtime must provide for each layer is described in the layer docs.

## Contract

- In: agent file + input (+ identity).
- Out: a `RunEvent` stream ending in `run_end { status, output, usage, costUsd }`.
- HTTP: `reinloop serve`, port 8700.

Details in [contracts.md](../contracts.md#l2-harness).

## How to test

```bash
make test LAYER=l2-harness
```

Live test: loads `layers/l2-harness/agents/assistant.md`, runs it against Ollama (`LLM_BASE_URL`, `LLM_MODEL`) and
asserts a completed run with non-empty output. Skips with a message if Ollama or the model is unavailable.
