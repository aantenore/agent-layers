# Interfaces, channels & triggers

Layer id `interface` (L8), Experience plane. *Who talks to it and what starts it?*

## Responsibility

How people, apps and other agents talk to an agent, and what starts a run without a person. A channel turns a chat UI,
an IDE, another agent or a web frontend into a call to the [harness](harness.md) and streams the run back. A trigger
starts runs from events and schedules. Neither adds agent logic.

## Ports

| Port | What it does |
|---|---|
| [ChannelPort](../../spec/ports/ChannelPort.md) | `serve` a stack host to people, apps and agents; the host exposes `agents`, `run`, `stream` and `verify` |
| [TriggerPort](../../spec/ports/TriggerPort.md) | `start` a handler that receives events and schedules |

Data shape: [trigger.json](../../spec/schemas/trigger.json).

## Standards

| Audience | Standard |
|---|---|
| Any chat UI | OpenAI-compatible chat API |
| IDEs and MCP clients | MCP server |
| Other agents | A2A (Agent2Agent, Linux Foundation, Apache-2.0) |
| Agent to frontend event streaming | AG-UI (MIT) |
| Events | CloudEvents |

## Boundaries

- **Identity.** The channel passes the caller's credential through; [identity](identity.md) verifies it. The interface
  never invents an identity.
- **Ingress.** Traffic enters through the ingress of [infra](infra.md).
- **Transparency.** The channel tells users they are talking to an agent; see
  [governance](../cross-cutting/governance-compliance.md).

## How to swap

Any chat UI that speaks the OpenAI API replaces another with a base URL change. MCP clients and A2A agents connect to
the same agents through their own endpoints. Where a channel has no standard, write a channel adapter; the conformance
suite checks that the run carries the caller's identity, that streamed output reassembles to the final output, and
that errors surface as channel-native errors.

## Reference adapters

| Adapter | Maps |
|---|---|
| `terminal-channel` | A terminal (stdin and stdout) |

Planned: OpenAI-compatible chat API, MCP server, A2A and CloudEvents. Full list: [adapters.md](../adapters.md).

## Reference setup

None yet. LibreChat (MIT) pointed at the OpenAI-compatible endpoint is the planned reference. The planned test starts the
stack, sends a chat completion with an agent name as `model`, and checks the streamed answer against the same run's
final output.
