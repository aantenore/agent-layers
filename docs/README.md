# Documentation

Every page, grouped by what you are doing. The project overview is the [repository README](../README.md).

## Start

- [Guide](guide.md): start a project, write an adapter or a runtime adapter, the stack config, from prototype to
  production, the CLI, [troubleshooting](guide.md#troubleshooting).
- [Product](product.md): who it is for, what it promises, how it compares.

## Concepts

- [Architecture](architecture.md): ports, adapters, profiles, pipelines.
- [The stack on one page](stack.md): the eleven layers, their ports and reference adapters.
- Layers, one page each: [infra](layers/infra.md), [llm](layers/llm.md), [cache](layers/cache.md),
  [harness](layers/harness.md), [knowledge](layers/knowledge.md), [tool](layers/tool.md),
  [identity](layers/identity.md), [guardrail](layers/guardrail.md), [interface](layers/interface.md),
  [telemetry](layers/telemetry.md), [eval](layers/eval.md).
- [Lifecycle](lifecycle.md) and [diagrams](diagrams.md).

## Operate

- [Gateway](gateway.md): host a stack for any language (OpenAI-compatible, MCP, A2A, CloudEvents).
- [Limits](limits.md): every limit, its default and safe range.
- [Security](cross-cutting/security.md): threats, what agent-layers enforces and what is yours.
- [Cost](cross-cutting/cost.md) and [governance and compliance](cross-cutting/governance-compliance.md).
- [Contracts](contracts.md): host ports and environment of the reference setups.

## Reference

- [Adapters](adapters.md): every adapter, its status and maturity.
- [The language-neutral spec](../spec/README.md), [the SDK language](../spec/language.md),
  [versioning](../spec/VERSIONING.md).
- [Vertical slice](slice.md) and [layer swap matrix](swap.md): what was run end to end, and how to re-run it.

## Decisions

- [Architecture decision records](decisions/README.md): [0001 the SDK language](decisions/0001-sdk-language.md),
  [0002 delegation bounds](decisions/0002-delegation-bounds.md), [0003 run resume](decisions/0003-run-resume.md),
  [0001 migration notes](decisions/0001-migration-notes.md).
