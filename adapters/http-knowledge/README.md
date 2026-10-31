# @agent-layers/adapter-http-knowledge

Maps the **agent-layers knowledge HTTP contract** → **KnowledgePort** (layer `knowledge`). Direction: outbound.
Tier: prototype, production. Maturity: experimental.

The contract is the shape any knowledge service, in any language, can implement:

```
POST {url}
{ "query": "text", "k": 4, "filter": { "path": "guide.md" } }      filter is sent only when the query has one

200 { "passages": [ { "id": "guide#install", "text": "…", "source": "guide.md", "title": "Install", "url": "https://…",
                     "score": 0.8, "attrs": { "lang": "en" } } ] }
```

The wire keeps its own names: `query` carries the language's `KnowledgeQuery.text`. Items become
[`passage.json`](../../spec/schemas/passage.json) passages: `id` and `text` are required; `title`, `url` and `score` (the
service's raw score, fused by the core across sources) are kept; `attrs` (or `metadata`, the older name) become `attrs`,
and values that are not plain attributes (nested objects, mixed lists) go to `ext["http-knowledge.metadata"]`. The
passage `source` is the instance name; the item's own `source` is kept as `attrs.source` by the default `in` mapping
rule `{ "from": "/source", "to": "/attrs/source" }`, which a `mappings` entry for `knowledge.<name>` can replace or
extend (the rule source is the raw item). The service returns at most `k` passages, best first, applies `filter` to its
attributes, and answers an empty list when nothing matches. An item without text is dropped; a missing `id` is derived
from the text. A non-2xx status, a body without a `passages` array, an unreachable service and a cancelled query
reject; the stack reports them and carries on without the source. Redirects are never followed (a 3xx rejects), so the
query and the headers stay with the configured host.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | Endpoint of the service |
| `headers` | object | none | Static headers, for example an API key; `${env:NAME}` works |
| `forwardCallerCredential` | boolean | `false` | Send the caller's credential (`caller.credential`) as `Authorization: Bearer`, so the service can apply its own access rules; the error message masks it |
| `timeoutMs` | integer | 10000 | Time limit per query |
| `k` | integer | 4 | Passages requested when the query has no `k` |
| `errorBodyChars` | integer | 300 | Characters of an error body kept in the error message, after masking |
| `minSecretChars` | integer | 4 | Header values shorter than this are not masked in error bodies |

Limits accept `${env:NAME}`; `timeoutMs` also accepts `"unbounded"`, which `agent-layers check` fails on the production
tier. Ranges and checks: [docs/limits.md](../../docs/limits.md).

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
