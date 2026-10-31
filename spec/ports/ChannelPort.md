# ChannelPort

Layer: `interface` (L8 Interfaces, channels & triggers) · Version: 0.2.0 · Conformance: `checkChannel`

## Purpose

Expose the stack's agents to people, apps and other agents: a terminal, a web endpoint, a chat service, an agent-to-agent protocol. A channel receives input from outside, authenticates it, runs an agent and sends the result back.

## Operations

A channel implements `serve`, `mount`, or both. A channel that serves itself (a terminal) implements `serve`; a channel
that speaks a network standard implements `mount`, so a host server (the gateway) can serve it together with others on
one address, with authentication, limits and access logs in one place.

- `serve?(host: ChannelHost, opts?: {signal?: Signal}) → ChannelHandle`
  Start serving. Returns once the channel is ready. The handle stops it.
- `mount?(host: ChannelHost) → InboundMount`
  Return the routes the channel adds to a host server. The host calls a route only after it has authenticated the
  request, unless the route is `public`.

`ChannelHost` is what a channel can reach:

- `agents() → [String]` — names of the available agents.
- `run(agent: String, input: RunInput, ctx?: partial CallContext) → RunResult` — run an agent to completion.
- `stream?(agent: String, input: RunInput, ctx?: partial CallContext) → stream of RunEvent` — optional streamed run.
- `verify?(credential: String) → Identity` — verify an inbound credential through the identity port; absent when no identity port is configured.
- `model?() → ModelPort` — the stack's governed model: guards, cache, router and telemetry, without knowledge injection. Absent when no model is configured.
- `tools?() → ToolPort` — the stack's governed tools (policy, approval, authorization, guards, credentials bound to the caller), with the knowledge sources as read-only tools.

`InboundMount`:

- `routes: [InboundRoute]` — what the channel answers.
- `close?() → ()` — release what the mount holds (sessions, pending streams).

`InboundRoute`:

- `path: String` — exact path, or a prefix when it ends with `/*`. The most specific route wins: exact before prefix, longer before shorter.
- `methods?: [String]` — upper-case methods it answers; any when omitted.
- `public?: Boolean` — answered without authentication (discovery documents). Default false.
- `handle(request: Request, ctx: InboundContext) → Response` — on the web-standard Fetch `Request` and `Response` types, so a route runs on any host server.

`InboundContext`: `identity?` (the caller the host verified; absent only when the host accepted an anonymous request),
`requestId`, `signal` (aborted when the client goes away or the host's time limit expires) and `origin` (the public
`scheme://host:port` of the host, for absolute URLs).

`ChannelHandle`:

- `url?: String` — where the channel listens, when it has an address.
- `close() → ()` — stop the channel and release its resources.
- `done?: signal that completes` — resolves when the channel ends by itself, for example at the end of input on a terminal.

`RunInput`, `RunResult` and `RunEvent` are defined in [RuntimePort](RuntimePort.md); `CallContext` in the [port index](README.md#common-types).

## Data shapes

The channel moves the shapes of the runtime: input in, [RunResult](../schemas/run-result.json) or run events out. What the channel's own clients see (text lines, a web payload, a chat message) is the adapter's concern.

## Semantics

- Identity on mounted routes: the host verifies the caller before the route runs and passes it in `ctx.identity`; the route passes it on as `identity` in every `run`, `stream`, model and tool call. A route never verifies a second time and never replaces the caller with another identity.
- Identity on `serve`: when the host has `verify`, the channel verifies the credential it received and passes the resulting identity in `ctx.identity` on `run`. A credential that fails verification is rejected before any agent runs. A channel never invents an identity, and the raw token never leaves the context.
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

- The channel has `serve` or `mount`.
- `serve`, when present, resolves to a handle with a `close` function; `close` completes.
- `mount`, when present, resolves to at least one route with a path starting with `/`, a `handle` function and upper-case methods.
- When an exercise fixture is given (for `serve` or for `mount`): after driving the channel, the host received the expected input. Otherwise this part is skipped.

## Version history

- 0.1.0 — initial
- 0.2.0 — `serve` is optional; `mount` adds routes to a host server; the host offers `model` and `tools`

Example adapters: `terminal-channel` (maps stdin/stdout, `serve`); `openai-compatible`, `mcp` and `a2a` (map network standards, `mount`).
