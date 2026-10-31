# Tool reference setup

Layer page: [docs/layers/tool.md](../../docs/layers/tool.md).

How an agent acts on the world: call an API, run a function, use an MCP server.

## Standards and extension point

| Way | Standard / extension |
|---|---|
| MCP server, stdio and streamable HTTP | Model Context Protocol |
| API with a spec | OpenAPI 3 (JSON) |
| One-off endpoint | declarative HTTP tool (`@agent-layers/adapter-http-tools`) |
| Anything else | `defineTool` from `@agent-layers/adapter-functions`: any JS function (the universal escape hatch) |

Tool results are `{ ok, text, data? }`. Port: [ToolPort](../../spec/ports/ToolPort.md).

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

## Use it from the SDK

Native OpenAPI import (`@agent-layers/adapter-openapi`, no bridge needed); tool names are `<source>__<operationId>`:

```json
{
  "layers": { "tools": { "httpbin": { "adapter": "openapi", "options": { "spec": "reference/tool/openapi.json", "baseUrl": "${env:HTTPBIN_URL}" } } } },
  "agents": { "decoder": { "instructions": "Decode base64.", "model": "qwen3:4b", "tools": ["httpbin__decodeBase64"] } }
}
```

Same API through the bridge (`@agent-layers/adapter-mcp`; any MCP client works, not only this SDK):

```json
{
  "layers": { "tools": { "httpbin": { "adapter": "mcp", "options": { "url": "${env:OPENAPI_MCP_URL}", "readOnly": ["echoQuery", "decodeBase64", "checkBearer"] } } } },
  "agents": { "decoder": { "instructions": "Decode base64.", "model": "qwen3:4b", "tools": ["httpbin__decodeBase64"] } }
}
```

Bridge tools carry no MCP annotations, so the `mcp` adapter gives them risk `exec` unless you set `risk` or `readOnly`.

## How to swap

- A different API: replace `openapi.json` (JSON only) and `UPSTREAM_URL` in `compose.yml`.
- A different bridge: any server that exposes the API as streamable-HTTP MCP at `OPENAPI_MCP_URL`.
- A different runtime: the bridge and httpbin are runtime-agnostic. The tests use the SDK adapters only as the client.

## Contract

- MCP over stdio or streamable HTTP; OpenAPI 3 documents in JSON.
- HTTP tool config (`http-tools` options): `tools.<name> = { description, method, url, query?, headerArgs?, headers?, body?, bodyArg?, schema?, risk?, timeoutMs?, maxResultChars?, auth?: { audience, scopes? } }`.
- `auth` asks the caller's credentials (`ctx.credentials`) for a token for the audience and sends it as `Authorization: Bearer`.
  Without credentials the call is not made. The token is masked in what comes back.

## Tests

`test/tools.test.mjs` (node:test). Each live test skips with a reason when its service is unreachable.

1. JS function tool (`defineTool`) called by an agent of a composed stack (mock model, `basic-runtime`).
2. Declarative HTTP tool against httpbin (`createHttpTools`: path, query, body, error status, bearer auth).
3. Native OpenAPI import against httpbin (`createOpenApiTools`).
4. The same API through the MCP bridge (`createMcpTools`, streamable HTTP).
5. MCP stdio reference server (`createMcpTools`; needs `npx` and network on first run).
6. End-to-end agent run on the local model (`LLM_MODEL`, default `qwen3:4b`; `openai-compatible` model, `basic-runtime`, `openapi` tools) that must call an httpbin tool.
