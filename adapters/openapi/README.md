# @agent-layers/adapter-openapi

Maps **OpenAPI 3** → **ToolPort** (layer `tool`). Direction: outbound. Tier: prototype, production. Maturity:
experimental.

Turns each operation of an OpenAPI 3 document into a tool. The document is JSON (YAML is not read: convert it first),
given as a file path relative to the config directory, an `http(s)` URL, or inline.

- **Names and schemas**: the tool is named after the `operationId` (or `<method>_<path>`), characters outside
  `[A-Za-z0-9_.-]` replaced. Path, query and header parameters and the JSON request body become one input schema; a
  body object with properties is flattened into the arguments, any other body is the argument `body`. Local `$ref`s
  are inlined (a reference back into itself is cut), `nullable` becomes a type union. `Authorization`, `Accept` and
  `Content-Type` header parameters are left to the transport. Operations whose body is not JSON are skipped.
- **Include**: `include` lists operationId globs; the default is all operations.
- **Risk**: `read` for GET and HEAD, `write` otherwise; `risk` overrides it by method.
- **Server**: `baseUrl`, or the first `servers` entry (variables take their defaults; a relative one resolves against
  the URL the document came from).
- **Requests, auth, results**: as in `http-tools`. With `auth` every operation carries a bearer token from
  `ctx.credentials`, never sends without it, and redacts the token from responses. Non-2xx is an error result.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `spec` | string or object | required | OpenAPI 3 JSON: path, URL, or the document |
| `baseUrl` | string | `servers[0]` | Server the operations are called on |
| `include` | string[] | all | operationId globs to import |
| `risk` | object | by method | Risk by upper-case method, for example `{ "DELETE": "exec" }` |
| `auth` | `{ audience, scopes? }` | none | Bearer token from the caller credentials |
| `headers` | object | none | Static headers on every call; `${env:NAME}` works |
| `timeoutMs` | integer | 30000 | Time limit per request |
| `maxResultChars` | integer | 16000 | Response text cap |

```json
{
  "layers": {
    "tools": {
      "petstore": {
        "adapter": "openapi",
        "options": {
          "spec": "specs/petstore.json",
          "baseUrl": "${env:PETSTORE_URL}",
          "include": ["listPets", "showPetById"],
          "auth": { "audience": "petstore-api" }
        }
      }
    }
  }
}
```

The same document can be served as an MCP server by a bridge; use the `mcp` adapter for that.

## Tests

`npm test -w @agent-layers/adapter-openapi`. Unit tests use a local fixture API and the SDK conformance suite.
`test/live.test.ts` runs the reference document `reference/tool/openapi.json` against httpbin (`HTTPBIN_URL`) and skips
when it is down.
