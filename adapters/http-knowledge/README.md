# @agent-layers/adapter-http-knowledge

Maps the **agent-layers knowledge HTTP contract** → **KnowledgePort** (layer `knowledge`). Direction: outbound.
Tier: prototype, production. Maturity: experimental.

The contract is the shape any knowledge service, in any language, can implement:

```
POST {url}
{ "query": "text", "k": 4, "filter": { "path": "guide.md" } }      filter is sent only when the query has one

200 { "passages": [ { "id": "guide#install", "text": "…", "source": "guide.md", "score": 0.8, "metadata": {} } ] }
```

Passages follow [`passage.json`](../../spec/schemas/passage.json): `id` and `text` are required, no other fields are
kept. The service returns at most `k` passages, best first, applies `filter` to its metadata, and answers an empty
list when nothing matches. An item without text is dropped; a missing `id` is derived from the text; `source` defaults
to the source name. A non-2xx status, a body without a `passages` array, an unreachable service and a cancelled query
reject; the stack reports them and carries on without the source.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | Endpoint of the service |
| `headers` | object | none | Static headers, for example an API key; `${env:NAME}` works |
| `forwardIdentityToken` | boolean | `false` | Send the caller's raw token (`identity.token`) as `Authorization: Bearer`, so the service can apply its own access rules |
| `timeoutMs` | integer | 10000 | Time limit per query |
| `k` | integer | 4 | Passages requested when the query has no `k` |

```json
{
  "layers": {
    "knowledge": {
      "wiki": {
        "adapter": "http-knowledge",
        "options": { "url": "${env:KNOWLEDGE_URL}/search", "headers": { "x-api-key": "${env:KNOWLEDGE_KEY}" } }
      }
    }
  }
}
```

Services that already speak another protocol need no code here: a vector store behind an MCP server is covered by the
`mcp` adapter.

## Tests

`npm test -w @agent-layers/adapter-http-knowledge`. A local fixture service implements the contract; the SDK
conformance suite runs against it. There is no upstream product to pin, so there is no live test.
