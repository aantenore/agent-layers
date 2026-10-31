# @agent-layers/adapter-http-tools

Maps **HTTP/JSON** → **ToolPort** (layer `tool`). Direction: outbound. Tier: prototype, production. Maturity:
experimental.

Declares HTTP endpoints as tools in the config, with no code. Each call is one request built from the arguments.

- **Arguments**: `{param}` placeholders in the URL are filled (URL-encoded); `query` lists the arguments sent as query
  parameters (arrays repeat the key); `headerArgs` those sent as headers; with `body: "json"` the remaining arguments
  (or only `bodyArg`) are the JSON body. Arguments are validated against `schema` before anything is sent; without a
  `schema` one is derived from the placeholders and lists.
- **Risk**: `read` for GET and HEAD, `write` otherwise, unless `risk` says otherwise.
- **Auth**: with `auth: { audience, scopes? }` the request carries `Authorization: Bearer <token>` from
  `ctx.credentials`. Without credentials, or when the token request fails, nothing is sent and the result is an error.
  The token (and the secret of a static `Authorization` header) is removed from the response before the model sees it.
- **Results**: a non-2xx status is an error result with the start of the body. JSON is pretty-printed and returned as
  `data` too; binary bodies are summarized; text is cut at `maxResultChars`. An unreachable host, a timeout and a
  cancelled call reject.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `tools` | object | required | Tools by name (letters, digits, `_`, `.`, `-`) |
| `timeoutMs` | integer | 30000 | Default time limit per request |
| `maxResultChars` | integer | 16000 | Default response text cap |
| `errorBodyChars` | integer | 500 | Characters of an error body kept in the error result, after masking |
| `minSecretChars` | integer | 4 | Header and token values shorter than this are not masked |

Limits accept `${env:NAME}`; `timeoutMs` and `maxResultChars` (also per tool) accept `"unbounded"`, which
`agent-layers check` fails on the production tier. Ranges and checks: [docs/limits.md](../../docs/limits.md).

Per tool: `description`, `method`, `url` (absolute), `query`, `headerArgs`, `headers`, `body` (`json` or `none`),
`bodyArg`, `schema`, `risk`, `timeoutMs`, `maxResultChars`, `auth`. `${env:NAME}` and `${env:NAME:-default}` in `url`
and `headers` are resolved when the tools are created.

```json
{
  "layers": {
    "tools": {
      "orders": {
        "adapter": "http-tools",
        "options": {
          "tools": {
            "get_order": {
              "description": "Fetch an order by id",
              "method": "GET",
              "url": "${env:ORDERS_URL}/orders/{id}",
              "auth": { "audience": "orders-api" },
              "schema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"], "additionalProperties": false }
            },
            "create_order": {
              "description": "Create an order",
              "method": "POST",
              "url": "${env:ORDERS_URL}/orders",
              "query": ["dry"],
              "body": "json",
              "headers": { "x-api-key": "${env:ORDERS_KEY}" }
            }
          }
        }
      }
    }
  }
}
```

An API that has an OpenAPI document does not need this: use `openapi`.

## Tests

`npm test -w @agent-layers/adapter-http-tools`. Unit tests use a local fixture API and the SDK conformance suite.
`test/stack.test.ts` composes a stack (scripted model, basic runtime, `http-tools`, `openapi` and the `mcp` bridge) in
which the agent's tool call reaches the API. `test/live.test.ts` and the live stack test run against httpbin from
`reference/tool` (`HTTPBIN_URL`, `OPENAPI_MCP_URL`) and skip when it is down.
