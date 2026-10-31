# agent-layers-pydantic-ai

A [Pydantic AI](https://ai.pydantic.dev) agent in Python, served over A2A, that becomes the runtime of an
agent-layers stack. It plugs into the platform only through standards:

| Direction | Standard | Endpoint |
|---|---|---|
| The stack sends it each run | Agent2Agent (A2A) 1.0, JSON-RPC | `POST /` on `A2A_PORT`, card at `/.well-known/agent-card.json` |
| It calls the model | OpenAI Chat Completions | `${GATEWAY_URL}/v1`, with a model alias of the gateway |
| It calls the tools and knowledge | Model Context Protocol, streamable HTTP | `${GATEWAY_URL}/mcp` |

The agent owns the loop; the gateway owns everything around it. Each model call goes through the gateway's input
and output guards, cache, router and token usage; each tool call through policy, approval, authorization, tool guards
and credentials for the caller; all of it is traced on the gateway. The agent process holds no stack credentials.

It is a Python project managed with [uv](https://docs.astral.sh/uv/), not an npm workspace (there is no
`package.json`).

## Versions and licences

| Package | Version | Licence | Role |
|---|---|---|---|
| Python | 3.12 | PSF | |
| `pydantic-ai-slim[openai,mcp]` | 2.64.0 | MIT | Agent loop, OpenAI-compatible model client, MCP client |
| `fasta2a[pydantic-ai]` | 2.1.1 | MIT | A2A server and the Pydantic AI worker |
| `uvicorn` | 0.54.0 | BSD-3-Clause | ASGI server |

Exact versions of every dependency are in `uv.lock`.

Pydantic AI 2 removed `Agent.to_a2a()`; its replacement is `fasta2a.pydantic_ai.agent_to_a2a`. This project builds
the same parts itself (`FastA2A`, `AgentWorker`) so it can carry the caller's credential into each run.

**A2A version spoken: 1.0** (JSON-RPC binding). The card declares `protocolVersion: "1.0"`, and FastA2A 2.1.1
answers the 1.0 methods (`SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`) with 1.0 enums
(`TASK_STATE_*`, `ROLE_*`). The gateway's `a2a` runtime adapter talks 1.0 by default, so that is what runs between
them. The 0.3 method names (`message/send`, `tasks/get`) are answered as well.

## Topology

Two processes: the gateway hosts the stack, the stack's runtime is this agent, and this agent calls the gateway back
for its model and tools. The sequence diagram is in [harness.md](../../docs/layers/harness.md#remote-pydantic-ai-over-a2a).

## Run it with the minimal example

```bash
cd runtimes/pydantic-ai
uv sync
AGENT_FILE=../../examples/minimal/agents/assistant.md uv run agent-layers-pydantic-ai

# another shell
cd examples/minimal
npx agent-layers gateway --profile polyglot

# a third shell: an A2A message to the gateway, answered by the Python agent
curl -s localhost:8787/a2a/assistant -H 'Authorization: Bearer dev-token' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"messageId":"m1","role":"ROLE_USER","parts":[{"text":"Convert 100 C to Fahrenheit"}]}}}'
```

The same agent answers `model: "agent:assistant"` on the gateway's `/v1/chat/completions`. `--profile
polyglot-local` puts a model served on this machine (`LLM_BASE_URL`, `LLM_MODEL`, default `qwen3:4b`) behind the
gateway instead of the scripted one.

## The agent file

`AGENT_FILE` is an agent Markdown file of agent-layers, read like the core reads it: `key: value` and `key: [a, b]`
front matter between `---` fences (a one-line flow mapping for `settings`), the body as instructions. The same file
runs on the in-process runtimes and here. A file with `params` is refused, as the core refuses it.

| Key | Used as |
|---|---|
| `name` | Agent name (else `AGENT_NAME`, else the file name) |
| `description` | Description in the agent card |
| `model` | Model alias of the gateway's OpenAI-compatible API (`GATEWAY_MODEL` overrides it) |
| `tools` | Globs over the gateway's MCP tools (`<source>__<tool>`) |
| `knowledge` | Knowledge sources, served by the gateway as `knowledge__<source>` tools; all when omitted |
| `settings` | Model settings: `temperature`, `maxOutputTokens` (sent as `max_tokens`), `stop` |

The model must be an alias such as `default` or `mock`, never `agent:<name>`: the gateway would run an agent of
the stack again, and with this runtime that is this agent. Both the settings and the agent refuse it.

## Identity

1. The gateway verifies the caller and runs the agent as that caller.
2. The `a2a` runtime adapter asks the stack's credentials slot for a token for `auth.audience`, on behalf of the
   caller, and sends it as `Authorization: Bearer ...` with the A2A message.
3. This agent requires that bearer on every JSON-RPC request (401 otherwise) and keeps it in memory beside the task
   until the run starts. Every model request and the run's own MCP session carry it.
4. The gateway verifies it again on each call, so a credential it rejects fails the run: the agent gets no model
   and no tools.

The token is never stored with the task, returned, or logged. The agent does not verify it itself; the gateway does.
In the `polyglot` profile the static credentials table hands out the dev token for the audience `agent-gateway`,
which stands in for an on-behalf-of exchange; in production use the `oidc` credentials adapter in `on-behalf-of`
mode with the audience the gateway's identity layer accepts.

## Task ownership

Tasks and conversations are kept per caller. The store has a namespace for each owner, and the A2A server reads it
only through the namespace of the caller being served. The owner key is `sha256(bearer token)`; the token itself is
not stored, returned or logged.

- `GetTask`, `CancelTask` and `SubscribeToTask` on the id of another caller's task answer like an unknown id
  (`TaskNotFoundError`, -32001), so ids cannot be probed. A message that names a `taskId` must name one of the
  caller's own tasks.
- A `contextId` is the caller's own name for a conversation: another caller using the same `contextId` gets a separate
  conversation, and cannot read or extend yours. A run reads and writes the history in the namespace of its owner.
- At most `MAX_TASKS` tasks and `MAX_TASKS` conversations are kept, and `MAX_TASKS_PER_OWNER` (`MAX_TASKS // 4` unless set) of each per owner. To make
  room for a new task, an owner at its own cap, or any owner when the store is full, drops its own oldest finished task
  or least recently used idle conversation, whatever its age. If the store is full and the owner has nothing of its
  own to drop, it may reclaim the oldest finished task or idle conversation of another owner, but only one older than
  `CROSS_OWNER_MIN_AGE_S` (since the task finished or the conversation was last used). With no such victim the new task
  is refused with the JSON-RPC error -32000 "Too many tasks". Never dropped: a task that is submitted or working, and a
  conversation with such a task.
- A finished task is kept `FINISHED_TASK_TTL_S` seconds, and a conversation with no task in flight `IDLE_CONTEXT_TTL_S`
  seconds after its last use. Expiry is applied when the store is used, not by a timer.

Limits, because the agent does not verify the token (the gateway does, and has no introspection endpoint):

- A caller that presents a different token starts from nothing: on-behalf-of tokens are re-minted when they expire,
  so a long conversation (the gateway sends the session id as `contextId`) can outlive its token and lose its history.
- Callers that share one credential share one namespace. The static dev credentials of the `polyglot` profile hand
  every caller the same token.
- Anyone who can reach the endpoint can use any token string, including made-up ones, and fill the store with work in
  flight (up to `MAX_TASKS_PER_OWNER` per token), which is refused to everyone else until it ends. That is why the agent must
  be reachable only by the gateway, as below.

Tradeoff of the full-store rule. Without cross-owner reclaim, owners that are done could hold capacity until their
data expires and starve everyone else (hoarding). With unconditional reclaim, one caller could push out another's
recent work (cross-tenant eviction). The minimum age bounds both: recent data of other owners is safe, and old data
cannot be held forever. Because the owner key is a hash of an unverified bearer, a caller can mint any number of
owners, so these guarantees only hold against callers the gateway has verified. Run the agent behind the gateway
with `A2A_GATEWAY_SECRET` set (below) so that every caller is one the gateway has authenticated.

## Reaching the agent

The agent is meant to be called only by the gateway.

- It listens on loopback by default. A non-loopback `A2A_HOST` is refused at startup unless `A2A_ALLOW_REMOTE=1`; then
  keep it on a private network and set a gateway secret.
- With `A2A_GATEWAY_SECRET` set, every request except the agent card and `/healthz` must carry the header
  `X-Agent-Layers-Gateway: <secret>`, compared in constant time; without it the answer is the 401 of a missing bearer.
  The secret is not logged or echoed. Send it from the stack with the static `headers` option of the `a2a` runtime
  adapter:

  ```json
  { "adapter": "a2a", "options": { "url": "http://127.0.0.1:9100/.well-known/agent-card.json",
    "auth": { "audience": "agent-gateway" },
    "headers": { "X-Agent-Layers-Gateway": "${secret:A2A_GATEWAY_SECRET}" } } }
  ```

  `${env:A2A_GATEWAY_SECRET}` works the same when the secret is an environment variable of the gateway.

Also refused: requests with an `Origin` header (the agent is called server to server) and, when bound to loopback,
`Host` names that are not loopback ones. The agent card and `/healthz` are public.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_FILE` | required | Agent Markdown file |
| `AGENT_NAME` | from the file | Agent name |
| `GATEWAY_URL` | `http://127.0.0.1:8787` | Root of the agent-layers gateway |
| `GATEWAY_MODEL` | the file's `model` | Model alias of the gateway |
| `A2A_HOST` | `127.0.0.1` | Interface to listen on; anything but loopback needs `A2A_ALLOW_REMOTE=1` |
| `A2A_ALLOW_REMOTE` | unset | `1` allows a non-loopback `A2A_HOST` |
| `A2A_GATEWAY_SECRET` | unset | When set, requests must carry it in `X-Agent-Layers-Gateway` (see Reaching the agent) |
| `A2A_PORT` | `9100` | Port of the A2A server |
| `A2A_PUBLIC_URL` | `http://localhost:<port>/` | JSON-RPC URL written in the agent card |
| `MAX_CONCURRENT_RUNS` | `8` | Runs in parallel; `unbounded` removes the cap |
| `MAX_TASKS` | `1000` | Tasks, and conversations, kept in memory (min 4); `unbounded` removes the cap |
| `MAX_TASKS_PER_OWNER` | `MAX_TASKS // 4` | Tasks, and conversations, kept per caller key (see Task ownership) |
| `FINISHED_TASK_TTL_S` | `3600.0` | Seconds a finished task is kept; `unbounded` keeps it until it is dropped for room |
| `IDLE_CONTEXT_TTL_S` | `3600.0` | Seconds a conversation with no task in flight is kept after its last use; `unbounded` as above |
| `CROSS_OWNER_MIN_AGE_S` | `600.0` | Seconds another caller's finished task or idle conversation must be old to be reclaimed when the store is full |
| `SHUTDOWN_GRACE_S` | `10.0` | On SIGTERM or SIGINT, seconds runs in flight may finish before they are cancelled; `unbounded` waits for them |
| `MODEL_TIMEOUT_S` | `120.0` | Time limit of one model request, in seconds; `unbounded` sets none |
| `MAX_MODEL_REQUESTS` | `8` | Model requests per run; beyond it the run fails (FastA2A's worker sets no limit, so a model that keeps calling tools would loop until the caller gives up); `unbounded` removes the cap |
| `MODEL_PRICING` | unset | USD per million tokens by model alias, JSON `{"<alias>": {"inputPerMTok": 0.15, "outputPerMTok": 0.6}}` (both required) |
| `LOG_LEVEL` | `info` | Log level |

Limits are the numeric rows above (`MAX_*`, `*_TTL_S`, `*_AGE_S`, `*_GRACE_S`, `MODEL_TIMEOUT_S`); each is declared in
`LIMITS` in `settings.py` with its minimum and safe range. A value below the minimum is refused at startup, and
`unbounded` is accepted only where the row says so. A limit set to `unbounded` or outside its safe range is logged as
a warning at startup; the full table is in [limits](../../docs/limits.md#pydantic-ai).

Each completed task carries the run's token usage, summed over its model requests, in
`metadata["agent-layers"].usage` (`inputTokens`, `outputTokens`), where the stack's `a2a` runtime reads it into
`RunResult.usage`. When the agent's model alias has a price in `MODEL_PRICING`, `costUsd` is added; without a price
there is no cost (not 0), and when a model response omitted its usage neither is reported.

`GET /healthz` answers `{"status": "ok"}` while the server runs.

## Tests

```bash
uv run pytest                                   # in process, no gateway: agent file, settings, A2A server, identity
node --test runtimes/pydantic-ai/test-e2e.mjs   # from the repository root: gateway and agent as two processes
```

The end-to-end test starts `agent-layers gateway --profile polyglot` and this agent on free ports, then checks that
an A2A message and `agent:assistant` are answered through the gateway with the scripted model, that the tool call
went through `/mcp` and was authorized (`agent.access.check` and `agent.tool.call` spans), that requests without a credential
are refused by both processes and a rejected credential fails the run, that no token appears in either process's
output or in telemetry, and that both stop on SIGTERM. `POLYGLOT_LIVE=1` adds a run on `polyglot-local`, skipped
when the model is not served.

## Limits

- Tasks, conversation history and pending credentials are in memory: one process, lost on restart.
- Tasks are scoped per caller by a hash of the bearer token, not by a verified subject (see Task ownership). Keep this
  agent reachable only by the gateway (loopback or a private network).
- `CancelTask`: FastA2A's Pydantic AI worker does nothing on cancel, so a cancelled task would stay `working` and
  finish as `completed`, its run still calling the model and tools. Here `CallerWorker.cancel_run` marks a task that has
  not ended (`submitted` or `working`) as `canceled`, stops its run at the next await (the in-flight model or tool
  request is dropped, no further call is made, no result or artifact is written) and ends its stream with `canceled`;
  the reply to `CancelTask` already shows `canceled`. A task that already ended is returned unchanged. Work the gateway
  has already accepted (a tool call executing there) is not undone.
- This process records no spans of its own. It forwards the W3C `traceparent` and `tracestate` of the A2A request
  on every model call (`/v1`) and MCP call (`/mcp`) of the run, so the gateway records them as children of the span
  that sent the A2A message: one trace from the gateway's request to the tool call. A malformed context is dropped.
- Each run opens its own MCP session. The gateway serves the stateless 2026-07-28 revision the MCP client tries
  first, so there is no fallback request.
