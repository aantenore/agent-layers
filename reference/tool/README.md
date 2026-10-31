# Tool reference setup

Layer page: [docs/layers/tool.md](../../docs/layers/tool.md).

How an agent acts on the world: call an API, run a function, use an MCP server.

## Standards and extension point

| Way | Standard / extension |
|---|---|
| MCP server, stdio and streamable HTTP | Model Context Protocol |
| API with a spec | OpenAPI 3 (JSON) |
| One-off endpoint | declarative HTTP tool |
| Anything else | `defineTool`: any JS function (the universal escape hatch) |

Tool results are strings, plus optional `data`. Reference docs: reinloop `docs/layers/tool.md`.

## Reference implementation

| Piece | Implementation | License |
|---|---|---|
| API under test | [go-httpbin](https://github.com/mccutchen/go-httpbin) `2.26.0` | MIT |
| OpenAPI to MCP bridge | [FastMCP](https://github.com/jlowin/fastmcp) `4.1.4` (`FastMCP.from_openapi`) | Apache-2.0 |
| MCP stdio reference server | `@modelcontextprotocol/server-everything@2.1.0` (run with `npx`) | see package |

`openapi.json` is a small OpenAPI 3 subset of httpbin (5 operations). Both the native importer and the bridge read it.

## Run

```
make up LAYER=tool      # httpbin on 8085, MCP bridge on 8090
make test LAYER=tool
make down LAYER=tool
```

Contract: `HTTPBIN_URL=http://localhost:8085`, `OPENAPI_MCP_URL=http://localhost:8090/mcp`. The compose file binds
`127.0.0.1` only. If 8090 is taken on your host, set `OPENAPI_MCP_PORT=8091` before `make up` and point
`OPENAPI_MCP_URL` at it. The `httpbin` image has no shell, so it has no healthcheck of its own; the bridge's check
probes it.

## Use it from reinloop

Native OpenAPI import (no bridge needed):

```json
{
  "openapi": { "httpbin": { "spec": "reference/tool/openapi.json", "baseUrl": "${env:HTTPBIN_URL}" } },
  "agents": { "decoder": { "tools": ["httpbin__decodeBase64"] } }
}
```

Same API through the bridge (any MCP client works, not only reinloop):

```json
{
  "mcpServers": { "httpbin": { "url": "${env:OPENAPI_MCP_URL}", "readOnly": ["echoQuery", "decodeBase64", "checkBearer"] } },
  "agents": { "decoder": { "tools": ["httpbin__decodeBase64"] } }
}
```

Bridge tools carry no MCP annotations, so reinloop gives them risk `exec` unless you set `risk` or `readOnly`.

## How to swap

- A different API: replace `openapi.json` (JSON only) and `UPSTREAM_URL` in `compose.yml`.
- A different bridge: any server that exposes the API as streamable-HTTP MCP at `OPENAPI_MCP_URL`.
- A different runtime: the bridge and httpbin are runtime-agnostic. The tests need reinloop only as the client.

## Contract

- MCP over stdio or streamable HTTP; OpenAPI 3 documents in JSON.
- HTTP tool config: `httpTools.<name> = { description, method, url, query?, headers?, body?, schema, risk, timeoutMs?, auth?: { audience } }`.
- `auth` asks the run's `CredentialProvider` for a token for the audience and sends it as `Authorization: Bearer`. Without
  credentials the call is not made. The token is never logged or emitted.

## Tests

`test/tools.test.mjs` (node:test). Each live test skips with a reason when its service is unreachable.

1. JS function tool.
2. Declarative HTTP tool against httpbin (path, query, body, error status, bearer auth).
3. Native OpenAPI import against httpbin.
4. The same API through the MCP bridge (streamable HTTP).
5. MCP stdio reference server (needs `npx` and network on first run).
6. End-to-end agent run on the local model (`LLM_MODEL`, default `qwen3:4b`) that must call an httpbin tool.
