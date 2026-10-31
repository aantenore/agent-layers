# @agent-layers/adapter-a2a

Exposes **ChannelPort** through the **Agent2Agent (A2A) protocol** (layer `interface`, inbound) and maps the
**Agent2Agent (A2A) protocol** → **RuntimePort** (layer `harness`, outbound). Tier: prototype, production. Maturity:
experimental. One package, two descriptors, both named `a2a`. Zero dependencies.

**Pinned version: A2A 1.0** (specification at a2a-protocol.org, checked October 2026), JSON-RPC binding. The 0.3
JSON-RPC methods (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`) are also accepted and answered with
the 0.3 shapes (`kind` tags, lower-case states and roles), for clients that have not moved to 1.0 yet.

## Inbound: the stack's agents for other agents (`channels` slot)

Mounted by the gateway. Other agents, in any language, discover and call the stack's agents; every run goes through
the runtime with the caller's identity, so guards, authorization and telemetry apply as for any other channel.

- `GET /.well-known/agent-card.json`: the card of the default agent. `GET /a2a/<agent>/.well-known/agent-card.json`:
  the card of each served agent. Cards are public; they list the JSON-RPC endpoint `<origin>/a2a/<agent>` in
  `supportedInterfaces` (1.0 and 0.3), streaming support, one skill per agent and, when the stack has an identity
  layer, a bearer security scheme. Behind a proxy, set `gateway.publicOrigin` so the URLs are right.
- `POST /a2a/<agent>` (authenticated by the gateway, `Content-Type: application/json`):
  - `SendMessage`: runs the agent on the text of the message and answers `{ task }` with the final state, the answer
    as an artifact and as the status message. `configuration.returnImmediately: true` answers at once with a working
    task (0.3: `configuration.blocking: false`).
  - `SendStreamingMessage`: Server-Sent Events: the task, the answer as an `artifactUpdate`, the final `statusUpdate`.
  - `GetTask`, `CancelTask` on the caller's own tasks; a task of another caller is not found (`-32001`).
  - Errors: `-32009` for an `A2A-Version` other than 1.0 or 0.3, `-32601` for other methods (push notifications,
    `ListTasks`, `SubscribeToTask` are not offered), `-32602` for a message without user text, `-32002` when a task
    can no longer be canceled. Other failures answer `internal error`, never the error text.
- Run outcome → task state: completed → `COMPLETED`; stopped by a guard → `REJECTED`; aborted → `CANCELED`; anything
  else → `FAILED` with a fixed status message.
- The `contextId` of a message is the session of the run, separate per caller: the same `contextId` from another
  caller is another session.
- Tasks are kept for `GetTask` for `taskTtlMs` after they finish, capped per caller and in total. A full store drops
  the oldest finished task of the caller holding the most; tasks in progress are never dropped. Anonymous tasks (only
  with `gateway.anonymous: true`) are each owned by their own id and share one pool.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `basePath` | string | `/a2a` | Prefix of the agent endpoints |
| `agents` | string[] | all | Agents served |
| `defaultAgent` | string | first served | Agent of `/.well-known/agent-card.json` |
| `descriptions` | object | `Agent <name>` | Description per agent in its card |
| `version` | string | `0.1.0` | Agent version in the cards |
| `provider` | `{ organization, url }` | none | Provider in the cards |
| `maxTasksPerCaller` | integer | `100` | Tasks per caller (and of the anonymous pool); at most a quarter of `maxTasks` |
| `maxTasks` | integer | `10000` | Tasks kept in total |
| `taskTtlMs` | integer | `3600000` | How long a finished task stays readable |

```json
{ "layers": { "channels": [{ "adapter": "a2a", "options": { "agents": ["assistant"], "descriptions": { "assistant": "Answers questions about the fleet." } } }] } }
```

## Outbound: a remote A2A agent as the runtime (`runtime` slot)

An agent written in any language, served over A2A, becomes the runtime of the stack: each run is one message to it.
`url` is its agent card (the JSON-RPC interface for the configured version is read from it) or its JSON-RPC endpoint.
With `auth`, every call carries a bearer token for `auth.audience` (from the config, never from the card) from the
stack's credentials slot, requested on behalf of the caller of the run.

The card cannot send that token elsewhere. The endpoint it names is used only when it has the card's own origin or
is listed in `allowedEndpoints`; targets must use https (plain http only to loopback, or with `allowHttp`); private,
loopback and link-local addresses are refused unless the operator configured that origin (`url`, `endpoint` or
`allowedEndpoints`); redirects are not followed; the token is minted only after the target passed these checks, and
the card itself is fetched without it. Set `endpoint` to skip the card. Host names are checked as written, not after
DNS resolution: restrict egress at the network level as well. A task that is still working is polled with `GetTask` until it ends. Failures are
failed runs with a fixed reason (`remote agent call failed`, `remote agent timed out`); error bodies are not read,
so a token echoed by the remote side never reaches the run result. The call is a span `a2a.send` on the `harness`
layer.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | Agent card URL or JSON-RPC endpoint |
| `endpoint` | string | from the card | JSON-RPC endpoint, when the card is not to be trusted for it |
| `allowedEndpoints` | string[] | none | URLs or origins a card may point to besides its own origin |
| `allowHttp` | boolean | `false` | Plain http to hosts that are not loopback |
| `version` | `1.0` or `0.3` | `1.0` | Protocol version spoken to the remote agent |
| `auth` | `{ audience, scopes? }` | none | Bearer token from the credentials slot, on behalf of the caller |
| `headers` | object | none | Static headers |
| `timeoutMs` | integer | `300000` | Time limit of a run, polling included |
| `pollMs` | integer | `500` | Interval of `GetTask` while the task is working |

```json
{
  "layers": {
    "runtime": { "adapter": "a2a", "options": { "url": "https://agents.example.com/.well-known/agent-card.json", "auth": { "audience": "agents" } } },
    "credentials": { "adapter": "oidc", "options": { "issuer": "${env:OIDC_ISSUER}", "clientId": "${env:OIDC_CLIENT_ID}", "mode": "on-behalf-of" } }
  }
}
```

The runtime binds the agent spec's name only: instructions, tools and knowledge belong to the remote agent. Use the
gateway on the remote side to give it the stack's governed model and tools.
