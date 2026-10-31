# Knowledge reference setup

Layer page: [docs/layers/knowledge.md](../../docs/layers/knowledge.md).

Gives the agent facts it was not trained on. No standard exists for the shape of a retrieval result, so this layer is
an adapter SDK: one small interface, adapters for the open standards that do exist (MCP tools, HTTP), and a
conformance check for your own source.

| | |
|---|---|
| Standard | MCP tools (retrieval servers) |
| Extension point | `KnowledgeSource { name; search({ query, k, filter, identity, signal }) -> Passage[] }` (JS) |
| Reference, vector | Qdrant `v1.20.0` (Apache-2.0) + `mcp-server-qdrant==0.8.1` (Apache-2.0), embeddings `sentence-transformers/all-MiniLM-L6-v2` (Apache-2.0) |
| Reference, zero infrastructure | A Markdown "LLM wiki" folder (`wiki/`), split by heading and ranked by keyword overlap |
| Runtime documentation | reinloop `docs/layers/knowledge.md` |

## Contract

```ts
interface KnowledgeSource { name: string; search(q: { query: string; k?: number; filter?: object; identity?: Identity; signal?: AbortSignal }): Promise<Passage[]> }
interface Passage { id: string; text: string; source?: string; score?: number; metadata?: object }
```

Schema: [`spec/schemas/passage.json`](../../spec/schemas/passage.json). Wire options, any of which can back a source:

1. An MCP tool that returns passages (Qdrant: `qdrant-find`).
2. HTTP: `POST {url}` with `{query, k, filter}` returns `{passages: Passage[]}`.
3. A JS function.

The `knowledge` middleware adds the top-k passages before the model call as a delimited block marked untrusted, with
numbered citations, and emits a `knowledge_retrieval` event (source, query, number of passages, ids). The
`search_knowledge` tool lets the model query on its own.

## Files

| Path | Content |
|---|---|
| `compose.yml` | Qdrant, port 6333 on localhost, healthcheck on `/readyz`, data in a named volume |
| `wiki/` | Four invented pages (the "Port of Quillmere"): answers prove retrieval, the facts are true nowhere else |
| `docs/` | Three invented documents loaded into Qdrant |
| `scripts/ingest.mjs` | Loads Markdown into Qdrant through `qdrant-store`, one point per heading section |
| `scripts/qdrant-server.mjs` | The one `mcp-server-qdrant` setting used by both ingest and search |
| `reinloop.json`, `agents/librarian.md` | Sample config (sources `docs` and `wiki`) and an agent with auto-retrieval |
| `test/knowledge.test.mjs` | Live tests |

## Run

```bash
make up LAYER=knowledge                       # Qdrant on :6333
node reference/knowledge/scripts/ingest.mjs      # first run downloads the embedding model (~90 MB) via uvx
export REINLOOP_MODEL=ollama/qwen3:4b OLLAMA_BASE_URL=http://localhost:11434/v1
cd reference/knowledge
reinloop run -a librarian "When does the Zorblax tide gate close?"
reinloop run -a librarian "How often does the Aurelian Archive rotate its vault code?"
```

Requirements: Docker, `uv` (for `uvx`), Node >= 22.18. The wiki source needs none of them: remove `docs` from
`knowledge.sources` and nothing else is required.

`ingest.mjs` recreates the collection first so reruns do not duplicate points; pass `--append` to keep it. Store and
find must use the same embedding model, which is why both start `mcp-server-qdrant` from `qdrant-server.mjs`
(`EMBEDDING_MODEL`, default `sentence-transformers/all-MiniLM-L6-v2`).

## Swap it

| Want | Do |
|---|---|
| Another vector store | Point a source at its MCP server (`knowledge.sources.<name>`: `type: mcp`, `server` or `command`/`url`, `tool`). Chroma, pgvector and others have MCP servers. If the output is not one of the formats `mcpKnowledge` understands, pass `parse` in JS. |
| Your own service | Expose `POST /search` returning `{ passages }` and add `{ "type": "http", "url": "..." }`. |
| Your own code | Implement `KnowledgeSource`, then run the conformance check below. |
| Another embedding model | Set `EMBEDDING_MODEL` and re-run the ingest. |
| PDFs, Office files | Convert first with [Docling](https://github.com/docling-project/docling) (MIT): it turns PDF, DOCX, PPTX, HTML and images into Markdown, which `ingest.mjs` already accepts, or use its MCP server. |
| Graph retrieval | [Graphiti](https://github.com/getzep/graphiti) (Apache-2.0, temporal knowledge graph, has an MCP server) or [LightRAG](https://github.com/HKUDS/LightRAG) (MIT, graph plus vector, HTTP API). Put them behind MCP or an HTTP endpoint that returns passages and they are sources like any other. |

## Conformance

```js
import { reinloop } from '../../lib/reinloop.mjs';
const failures = await reinloop.checkKnowledgeSource(mySource, { query: 'a question it can answer', expectId: 'doc-1' });
// [] means conformant
```

## Test

```bash
make test LAYER=knowledge
# against a local reinloop checkout
REINLOOP_SRC=/path/to/reinloop/src/index.ts make test LAYER=knowledge
```

Three tests:

1. Conformance of the wiki source (no infrastructure).
2. Conformance of the Qdrant source through `mcp-server-qdrant`. Skips when Qdrant is unreachable; ingests the sample
   documents if the collection is empty.
3. An agent on the local model (`LLM_MODEL`, default `qwen3:4b`) answers a wiki fact and a Qdrant fact using auto-retrieval,
   and the run records a `knowledge_retrieval` event with the expected passage id. Skips when Ollama or the model is
   missing; the Qdrant half is dropped when Qdrant is unreachable.

## Notes

- Passage text is third-party content. The middleware marks it untrusted and escapes a closing tag, but a retrieved page
  can still try to steer the model: keep the guardrail layer on for sources you do not control.
- `identity` reaches every source. A source enforcing per-user access reads it there; reinloop never writes
  `identity.token` to events or logs.
