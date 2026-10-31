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
front matter between `---` fences, the body as instructions. The same file runs on the in-process runtimes and here.

| Key | Used as |
|---|---|
| `name` | Agent name (else `AGENT_NAME`, else the file name) |
| `description` | Description in the agent card |
| `model` | Model alias of the gateway's OpenAI-compatible API (`GATEWAY_MODEL` overrides it) |
| `tools` | Globs over the gateway's MCP tools (`<source>__<tool>`) |
| `knowledge` | Knowledge sources, served by the gateway as `knowledge__<source>` tools; all when omitted |

The model must be an alias such as `default` or `mock`, never `agent:<name>`: the gateway would run an agent of
the stack again, and with this runtime that is this agent. Both the settings and the agent refuse it.

## Identity

1. The gateway verifies the caller and runs the agent with the caller's identity.
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

Also refused: requests with an `Origin` header (the agent is called server to server) and, when bound to loopback,
`Host` names that are not loopback ones. The agent card and `/healthz` are public.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_FILE` | required | Agent Markdown file |
| `AGENT_NAME` | from the file | Agent name |
| `GATEWAY_URL` | `http://127.0.0.1:8787` | Root of the agent-layers gateway |
| `GATEWAY_MODEL` | the file's `model` | Model alias of the gateway |
| `A2A_HOST` | `127.0.0.1` | Interface to listen on |
| `A2A_PORT` | `9100` | Port of the A2A server |
| `A2A_PUBLIC_URL` | `http://localhost:<port>/` | JSON-RPC URL written in the agent card |
| `MAX_CONCURRENT_RUNS` | `8` | Runs in parallel |
| `SHUTDOWN_GRACE_S` | `10` | On SIGTERM or SIGINT, how long runs in flight may finish before they are cancelled |
| `MODEL_TIMEOUT_S` | `120` | Time limit of one model request |
| `LOG_LEVEL` | `info` | Log level |

`GET /healthz` answers `{"status": "ok"}` while the server runs.

## Tests

```bash
uv run pytest                                   # in process, no gateway: agent file, settings, A2A server, identity
node --test runtimes/pydantic-ai/test-e2e.mjs   # from the repository root: gateway and agent as two processes
```

The end-to-end test starts `agent-layers gateway --profile polyglot` and this agent on free ports, then checks that
an A2A message and `agent:assistant` are answered through the gateway with the scripted model, that the tool call
went through `/mcp` and was authorized (`authorize` and `execute_tool` spans), that requests without a credential
are refused by both processes and a rejected credential fails the run, that no token appears in either process's
output or in telemetry, and that both stop on SIGTERM. `POLYGLOT_LIVE=1` adds a run on `polyglot-local`, skipped
when the model is not served.

## Limits

- Tasks, conversation history and pending credentials are in memory: one process, lost on restart.
- Tasks are not scoped per caller here; the gateway scopes them for its callers. Keep this agent reachable only by
  the gateway (loopback or a private network).
- `CancelTask` does not stop a run in progress (FastA2A's Pydantic AI worker does not implement it).
- Spans of the gateway and of this process are not joined into one trace: the A2A call carries no trace context.
- Each run opens its own MCP session. The MCP client first tries the stateless 2026-07-28 revision, which the
  gateway answers with 400, then falls back to the initialize handshake: one extra request per run.
