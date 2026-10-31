# @agent-layers/adapter-mcp

Maps **Model Context Protocol** → **ToolPort** (layer `tool`) and **KnowledgePort** (layer `knowledge`), outbound,
and exposes **ChannelPort** through **Model Context Protocol** (layer `interface`), inbound. Tier: prototype,
production. Maturity: experimental.

One package, three descriptors, all named `mcp`. Each outbound instance talks to one MCP server, over stdio (a child process) or
streamable HTTP (JSON or SSE responses, `Mcp-Session-Id`). A lost HTTP session (404) is reopened once; a stdio server
that exited is restarted on the next call.

## Tools (`tools` slot)

Lists the tools of the server and calls them. Tool names are the server's own, with characters outside
`[A-Za-z0-9_.-]` replaced by `_`; the stack adds the source name, so a tool `search` of the source `docs` is
`docs__search`.

- **Risk**: `risk` forces a level for every tool; otherwise a tool matching `readOnly` is `read`, `readOnlyHint` gives
  `read`, `destructiveHint: false` gives `write`, anything else `exec`.
- **Results**: text content, with resources and other parts summarized; `structuredContent` goes to `data`. A tool
  that reports `isError`, or a JSON-RPC error answering a call, is an error result. An unreachable server, an HTTP
  error status and a cancelled call reject.
- **Auth**: with `auth: { audience, scopes }` (HTTP only) every call carries `Authorization: Bearer <token>` from
  `ctx.credentials`, which replaces a static `authorization` header. Without credentials nothing is sent and the call
  is an error result. A token echoed back by the server is redacted. The connection requests (initialize, tool list)
  use the `credentials` given to the factory, or else those of the call that opens the connection.
- The tool list is cached for `toolsTtlMs`.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `command`, `args`, `env`, `cwd` | string, string[], object, string | none | stdio transport (set `command` or `url`, not both) |
| `url` | string | none | Streamable HTTP endpoint |
| `headers` | object | none | Static headers (HTTP) |
| `auth` | `{ audience, scopes? }` | none | Per-call bearer token from the caller credentials (HTTP) |
| `timeoutMs` | integer | 60000 | Time limit per request |
| `errorBodyChars` | integer | 300 | Characters of an error body kept in the error message, after masking |
| `minSecretChars` | integer | 4 | Header and token values shorter than this are not masked in errors |
| `stderrChars` | integer | 2000 | stdio: characters of the server's stderr kept for error messages |
| `risk` | `read`, `write`, `exec` | derived | Risk of every tool |
| `readOnly` | string[] | `[]` | Globs of tools that are read-only |
| `include`, `exclude` | string[] | all, none | Globs of tool names to expose or hide |
| `toolsTtlMs` | integer | 60000 | How long the tool list is cached |

Limits accept `${env:NAME}`; `timeoutMs` also accepts `"unbounded"`, which `agent-layers check` fails on the production
tier. Ranges and checks: [docs/limits.md](../../docs/limits.md).

`${env:NAME}` and `${env:NAME:-default}` in the options are resolved when the instance is created.

```json
{
  "layers": {
    "tools": {
      "files": { "adapter": "mcp", "options": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything@2.1.0", "stdio"], "readOnly": ["echo"] } },
      "orders": { "adapter": "mcp", "options": { "url": "${env:ORDERS_MCP_URL}", "auth": { "audience": "orders-api" } } }
    }
  }
}
```

## Knowledge (`knowledge` slot)

Calls one retrieval tool of the server and turns its output into passages. The default parser understands, in order:

1. JSON: an array of passages (or strings), or an object with a `passages`, `results`, `documents`, `points`, `items` or
   `data` array. Items may use `text`, `content`, `document`, `page_content` or `passage` for the text.
2. `<entry><content>…</content><metadata>{json}</metadata></entry>`, the output of `mcp-server-qdrant`; the metadata
   `id` becomes the passage id.
3. Anything else is one passage ("No information found…" is none).

The query goes to `queryArg`; `k` goes to `kArg` and the filter to `filterArg` when set. Without `filterArg` the filter
is applied to the metadata of the returned passages. The result is cut to `k`. In code, `parse` replaces the parser.

| Option | Type | Default | Meaning |
|---|---|---|---|
| transport options | | | As above (`command`, `url`, `headers`, `timeoutMs`, ...) |
| `tool` | string | required | Retrieval tool, for example `qdrant-find` |
| `queryArg` | string | `query` | Argument that receives the query |
| `kArg` | string | none | Argument that receives `k` |
| `filterArg` | string | none | Argument that receives the filter |
| `toolArgs` | object | `{}` | Fixed arguments sent with every query |
| `k` | integer | 4 | Passages when the query has no `k` |

The transport options include `errorBodyChars`, `minSecretChars` and `stderrChars`. Limits accept `${env:NAME}`;
`timeoutMs` also accepts `"unbounded"` (fails `agent-layers check` on the production tier). Ranges and checks:
[docs/limits.md](../../docs/limits.md).

Qdrant, Chroma and similar vector stores need no adapter of their own: run their MCP server and point this adapter at
it. [`reference/knowledge`](../../reference/knowledge) has Qdrant with `mcp-server-qdrant==0.8.1` and the ingestion
script:

```json
{
  "layers": {
    "knowledge": {
      "docs": {
        "adapter": "mcp",
        "options": {
          "command": "uvx",
          "args": ["--python", "3.12", "mcp-server-qdrant==0.8.1"],
          "env": { "QDRANT_URL": "${env:QDRANT_URL}", "COLLECTION_NAME": "docs", "EMBEDDING_MODEL": "sentence-transformers/all-MiniLM-L6-v2" },
          "tool": "qdrant-find",
          "timeoutMs": 300000
        }
      }
    }
  }
}
```

## Server (`channels` slot): exposes ChannelPort through Model Context Protocol

Mounted by the gateway at `/mcp` (streamable HTTP), so any MCP client, in any language, uses the stack's tools with
the enforcement of the stack: policy, approval, authorization, `tool_args` and `tool_result` guards, credentials bound
to the caller, telemetry. Knowledge sources appear as read-only tools `knowledge__<source>` with a `query` argument.

- The gateway authenticates every request (`Authorization: Bearer ...`); the MCP session belongs to that caller, and
  a session id presented by another caller is answered like an unknown one (404).
- Two eras on the same endpoint. Legacy (2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05): `initialize` (returns
  `Mcp-Session-Id`; it answers the asked revision when served, else 2025-11-25, never an error), `ping`, `tools/list`,
  `tools/call`, `notifications/cancelled` (aborts the call in flight). Modern (2026-07-28, stateless, no session):
  `server/discover`, `tools/list`, `tools/call`, with the version in `params._meta` and the `MCP-Protocol-Version`,
  `Mcp-Method` and `Mcp-Name` headers (mismatch: 400 `-32020`; unknown revision: 400 `-32022` listing the served ones;
  unknown method: 404 `-32601`). Other legacy methods answer `-32601`; batches are refused. `DELETE /mcp` ends a session; `GET /mcp` (server-initiated streams) is not offered (405).
- Sessions expire after `sessionTtlMs` idle and after `maxSessionAgeMs` in any case. They are capped per caller and in
  total: a caller over its cap loses its own least recently used session (calls running in it are aborted); a full
  server makes room by evicting the least recently used session of the authenticated caller that holds the most.
- Anonymous callers (only with `gateway.anonymous: true`) cannot be told apart: each anonymous session is its own
  owner, reachable only with its id and never by an authenticated caller. Anonymous sessions share one pool of
  `maxSessionsPerCaller`; a full pool answers 429 and no anonymous session is evicted for a new one.
- Requests must be `Content-Type: application/json` (415 otherwise). The gateway refuses foreign `Origin` headers and,
  on loopback, unknown `Host` names, as the MCP transport requires against DNS rebinding.
- Answers are JSON, or a one-event SSE stream when the client accepts only `text/event-stream` (or `sse: true`).
- Tool names are the stack's `<source>__<tool>`; the risk becomes `readOnlyHint` and `destructiveHint`. A denied or
  blocked call is a tool result with `isError: true`, so the client's model can react; an unknown tool is `-32602`.
  Errors outside the protocol answer `internal error`, never the error text.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | `/mcp` | Endpoint path |
| `include` / `exclude` | string[] | all / none | Globs of tool names to expose or hide |
| `serverName` | string | `agent-layers` | `serverInfo.name` |
| `sse` | boolean | `false` | Always answer with an SSE stream |
| `sessionTtlMs` | integer | `1800000` | Idle time before a session is forgotten |
| `maxSessionAgeMs` | integer | `3600000` | Absolute lifetime of a session |
| `maxSessions` | integer | `1000` | Sessions in total |
| `maxSessionsPerCaller` | integer | `10` | Sessions per caller, and of the anonymous pool; at most a quarter of `maxSessions` |

Limits accept `${env:NAME}` and `"unbounded"`, which `agent-layers check` fails on the production tier. Ranges and
checks: [docs/limits.md](../../docs/limits.md).

```json
{ "layers": { "channels": [{ "adapter": "mcp", "options": { "exclude": ["admin__*"] } }] } }
```

## Tests

`npm test -w @agent-layers/adapter-mcp`. Unit tests use a local fixture server (HTTP with JSON and SSE, stdio) and the
SDK conformance suites. `test/live.test.ts` runs against the reference setups and skips when a service is missing: the
OpenAPI bridge (`OPENAPI_MCP_URL`), `@modelcontextprotocol/server-everything@2.1.0` through `npx`, and Qdrant through
`uvx mcp-server-qdrant==0.8.1` (`QDRANT_URL`).
