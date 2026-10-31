# L10 Interfaces & channels

## Responsibility

How people, apps and other agents talk to an agent. L10 turns a channel (a chat UI, an IDE, another agent, a web
frontend) into a call to the [L2](L2-harness.md) runtime and streams the run back. It adds no agent logic.

## Standard

| Audience | Standard |
|---|---|
| Any chat UI | OpenAI-compatible chat API |
| IDEs and MCP clients | MCP server |
| Other agents | A2A (Agent2Agent, Linux Foundation, Apache-2.0) |
| Agent to frontend event streaming | AG-UI (MIT) |

## Extension point

Channel adapters: a small component that maps a channel's messages and identity onto a run request, and the
`RunEvent` stream onto the channel's response format.

## Reference implementation

LibreChat (MIT), pointed at the OpenAI-compatible endpoint.

## Adapter SDK + conformance

Where a channel has no standard, write a channel adapter. A conformance check sends a fixed conversation through the
adapter and verifies that the run request carries the caller's identity, that streamed output reassembles to the
final output, and that errors surface as channel-native errors.

## Around the layer

- **Identity.** The channel passes the caller's token through; [L5](L5-identity.md) verifies it. L10 never invents an
  identity.
- **Ingress.** Traffic enters through the L0 ingress.
- **Transparency.** The channel tells users they are talking to an agent; see
  [governance](../cross-cutting/governance-compliance.md).

## How to swap it

Any chat UI that speaks the OpenAI API replaces LibreChat with a base URL change. MCP clients and A2A agents connect
to the same agents through their own endpoints.

## Contract

Target contract; status is planned. Details in [contracts.md](../contracts.md#l10-interfaces--channels).

- **OpenAI-compatible:** `POST /v1/chat/completions`, `model` = agent name, SSE streaming.
- **A2A:** agent card at `/.well-known/agent-card.json`, JSON-RPC `message/send` and `message/stream`.
- **MCP server:** agents served as tools.
- **AG-UI:** `RunEvent`s mapped to AG-UI events.

## How to test

Not implemented yet. The planned test starts the runtime, sends a chat completion with an agent name as `model`, and
checks the streamed answer against the same run's `run_end` output.
