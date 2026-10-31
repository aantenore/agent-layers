# ChannelPort

Layer: `interface` (L8 Interfaces, channels & triggers) · Version: 0.1.0 · Conformance: `checkChannel`

## Purpose

Expose the stack's agents to people, apps and other agents: a terminal, a web endpoint, a chat service, an agent-to-agent protocol. A channel receives input from outside, authenticates it, runs an agent and sends the result back.

## Operations

- `serve(host: ChannelHost, opts?: {signal?: Signal}) → ChannelHandle`
  Start serving. Returns once the channel is ready. The handle stops it.

`ChannelHost` is what a channel can reach:

- `agents() → [String]` — names of the available agents.
- `run(agent: String, input: RunInput, ctx?: partial CallContext) → RunResult` — run an agent to completion.
- `stream?(agent: String, input: RunInput, ctx?: partial CallContext) → stream of RunEvent` — optional streamed run.
- `verify?(credential: String) → Identity` — verify an inbound credential through the identity port; absent when no identity port is configured.

`ChannelHandle`:

- `url?: String` — where the channel listens, when it has an address.
- `close() → ()` — stop the channel and release its resources.
- `done?: signal that completes` — resolves when the channel ends by itself, for example at the end of input on a terminal.

`RunInput`, `RunResult` and `RunEvent` are defined in [RuntimePort](RuntimePort.md); `CallContext` in the [port index](README.md#common-types).

## Data shapes

The channel moves the shapes of the runtime: input in, [RunResult](../schemas/run-result.json) or run events out. What the channel's own clients see (text lines, a web payload, a chat message) is the adapter's concern.

## Semantics

- Identity: when the host has `verify`, the channel verifies the credential it received and passes the resulting identity in `ctx.identity` on `run`. A credential that fails verification is rejected before any agent runs. A channel never invents an identity, and the raw token never leaves the context.
- Errors and statuses of a run reach the client: a `stopped` or `failed` result is shown as such, with its `reason`.
- Streaming is optional. A channel that streams uses `host.stream` when present and falls back to `host.run`.
- A channel must only call agents listed by `host.agents()`.
- `serve` does not block until the end of the channel: it returns the handle. Use `done` or `close` to wait for or end it.
- `signal` in `opts` stops the channel like `close`.
- Approvals and long-running work can be surfaced by a channel, but the contract does not require it (see [ApprovalPort](ApprovalPort.md)).

## Errors

- `serve` rejects when the channel cannot start (port in use, bad credentials for the service).
- Per-request failures are reported to the client by the channel and do not stop it.

## Escape hatch

`native()` returns the underlying server or client. `ChannelHandle.url` exposes the address.

## Conformance

`checkChannel` verifies, against a fake host with one agent:

- `serve` resolves to a handle with a `close` function.
- When an exercise fixture is given: after driving the channel, the host received the expected input. Otherwise this part is skipped.
- `close` completes.

## Version history

- 0.1.0 — initial

Example adapters: `terminal-channel` (maps stdin/stdout).
