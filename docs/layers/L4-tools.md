# L4 Tools

## Responsibility

Let agents act: call APIs, read systems, run code. Tools are the main place where agents touch the outside world, so
they are also where identity ([L5](L5-identity.md)) and guardrails ([L6](L6-guardrails.md)) apply.

## Standard

- MCP (stdio and streamable HTTP).
- OpenAPI 3.

## Extension point

`defineTool`: any JS function becomes a tool, with a JSON Schema for its arguments and a risk level.

## Reference implementation

| Role | Reference | License |
|---|---|---|
| MCP servers | MCP reference servers (fetch, git, filesystem, ...) | MIT / Apache-2.0 per server |
| Declarative HTTP tools | reinloop `httpTools` config | MIT |
| HTTP test target | go-httpbin on `HTTPBIN_URL` | MIT |
| OpenAPI import | OpenAPI 3 JSON to HTTP tools, MCP bridge at `OPENAPI_MCP_URL` | - |

The tests call go-httpbin through declarative tools generated from its OpenAPI description.

## Adapter SDK + conformance

Not needed: the standards (MCP, OpenAPI) and `defineTool` already cover every way to add a tool.

## Around the layer

- **OpenAPI import.** An OpenAPI 3 description becomes a set of HTTP tools, one per operation.
- **Sandbox for code-executing tools.** Tools that run code do it in an OCI container with the network off. gVisor
  is an optional stronger boundary. See [security](../cross-cutting/security.md).
- **Egress rules.** `web_fetch` and HTTP tools reach only allowed hosts.

## How to swap it

Point an agent at any MCP server, or describe any HTTP API in config, or write a function. No adapter is needed: the
three ways are the extension points.

## Contract

- MCP over stdio or streamable HTTP.
- Declarative HTTP tool:

  ```
  httpTools.<name> = { description, method, url (with {param}), query?, headers? (${env:X}),
                       body?: 'json' | 'none', schema, risk, timeoutMs?, auth?: { audience } }
  ```

- Results are strings, plus optional `data`.

`auth.audience` asks L5 for a token for that audience (on-behalf-of or self). Details in
[contracts.md](../contracts.md#l4-tools).

## How to test

```bash
make up LAYER=l4-tools
make test LAYER=l4-tools
make down LAYER=l4-tools
```

Variables: `HTTPBIN_URL`, `OPENAPI_MCP_URL`.
