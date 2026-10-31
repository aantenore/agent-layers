# Knowledge reference setup

Layer page: [docs/layers/knowledge.md](../../docs/layers/knowledge.md).

Gives the agent facts it was not trained on. No standard exists for the shape of a retrieval result, so this layer is
an adapter SDK: one small interface, adapters for the open standards that do exist (MCP tools, HTTP), and a
conformance check for your own source.

| | |
|---|---|
| Standard | MCP tools (retrieval servers) |
| Extension point | `KnowledgePort { name; search({ text, k, filter, caller, signal }) -> Passage[] }` (JS) |
| Reference, vector | Qdrant `v1.20.0` (Apache-2.0) + `mcp-server-qdrant==0.8.1` (Apache-2.0), embeddings `sentence-transformers/all-MiniLM-L6-v2` (Apache-2.0) |
| Reference, zero infrastructure | A Markdown "LLM wiki" folder (`wiki/`), split by heading and ranked with BM25 (`markdown-knowledge`) |
| Adapters | `markdown-knowledge`, `mcp`, `http-knowledge` |

## Contract

```ts
interface KnowledgePort { name: string; search(q: { text: string; k?: number; filter?: AttrFilter; caller?: Caller; signal?: AbortSignal }): Promise<Passage[]> }
interface Passage { id: string; text: string; source: string; title?: string; url?: string; score?: number; attrs?: Attrs; ext?: Ext }
```

Schema: [`spec/schemas/passage.json`](../../spec/schemas/passage.json). Wire options, any of which can back a source:

1. An MCP tool that returns passages (Qdrant: `qdrant-find`), through the `mcp` adapter.
2. HTTP: `POST {url}` with `{query, k, filter}` returns `{passages: Passage[]}`, through `http-knowledge`.
3. A folder of Markdown files, through `markdown-knowledge`.
4. A JS function implementing `KnowledgePort`.

The composed stack adds the top-k passages before the model call as a delimited block marked untrusted, with numbered
citations, and records an `agent.knowledge.search` span per source. With `pipeline.knowledge.mode: "tools"` the sources
are exposed as read-only tools instead, so the model queries on its own.

## Files

| Path | Content |
|---|---|
| `compose.yml` | Qdrant, port 6333 on localhost, healthcheck on `/readyz`, data in a named volume |
| `wiki/` | Four invented pages (the "Port of Quillmere"): answers prove retrieval, the facts are true nowhere else |
| `docs/` | Three invented documents loaded into Qdrant |
| `scripts/ingest.mjs` | Loads Markdown into Qdrant through `qdrant-store`, one point per heading section (same sections and ids as `markdown-knowledge`) |
| `scripts/qdrant-server.mjs` | The one `mcp-server-qdrant` setting used by both ingest and search |
| `test/knowledge.test.mjs` | Conformance of both sources, and a composed stack (`mock-model` + `basic-runtime`) answering from each |

## Run

```bash
make up LAYER=knowledge                       # Qdrant on :6333
node reference/knowledge/scripts/ingest.mjs      # first run downloads the embedding model (~90 MB) via uvx
make test LAYER=knowledge
```

Requirements: Docker, `uv` (for `uvx`), Node >= 22.18. The wiki source needs none of them: without Qdrant the Qdrant
tests skip and the wiki ones still run.

`ingest.mjs` recreates the collection first so reruns do not duplicate points; pass `--append` to keep it. Store and
find must use the same embedding model, which is why both start `mcp-server-qdrant` from `qdrant-server.mjs`
(`EMBEDDING_MODEL`, default `sentence-transformers/all-MiniLM-L6-v2`).

## Swap it

| Want | Do |
|---|---|
| Another vector store | Point a `layers.knowledge.<name>` entry with `adapter: "mcp"` at its MCP server (`command` or `url`, plus `tool`). Chroma, pgvector and others have MCP servers. If the output is not one of the formats the `mcp` adapter understands, pass `parse` to `createMcpKnowledge` in JS. |
| Your own service | Expose an endpoint that accepts `POST {query, k, filter}` and returns `{ passages }`, and use `adapter: "http-knowledge"` with its `url`. |
| Your own code | Implement `KnowledgePort`, then run the conformance check below. |
| Another embedding model | Set `EMBEDDING_MODEL` and re-run the ingest. |
| PDFs, Office files | Convert first with [Docling](https://github.com/docling-project/docling) (MIT): it turns PDF, DOCX, PPTX, HTML and images into Markdown, which `ingest.mjs` already accepts, or use its MCP server. |
| Graph retrieval | [Graphiti](https://github.com/getzep/graphiti) (Apache-2.0, temporal knowledge graph, has an MCP server) or [LightRAG](https://github.com/HKUDS/LightRAG) (MIT, graph plus vector, HTTP API). Put them behind MCP or an HTTP endpoint that returns passages and they are sources like any other. |

## Conformance

```js
import { checkAdapter } from '@agent-layers/conformance';
const report = await checkAdapter(myAdapter, { options: { /* adapter options */ }, fixtures: { query: 'a question it can answer', expectText: 'text of the answer', filter: { file: 'a.md' } } });
// report.failures is [] when conformant
```

For a bare `KnowledgePort` instance use `conformance('KnowledgePort', port, fixtures)`.

## Test

```bash
make test LAYER=knowledge
```

Three tests:

1. Conformance of the wiki source (`markdown-knowledge`, no infrastructure), and the expected passage id.
2. Conformance of the Qdrant source (`mcp` adapter over `mcp-server-qdrant`), and the expected passage id. Skips when
   Qdrant or `uvx` is unavailable; ingests the sample documents if the collection is empty.
3. A composed stack (`compose(resolveProfile(config), { adapters })` with `mock-model` and `basic-runtime`) where one
   agent per source answers a fictional fact through auto-retrieval, and the run records an `agent.knowledge.search`
   span for that source. No model server is needed; the Qdrant half is dropped when Qdrant or `uvx` is unavailable.

Variables: `WIKI_DIR` (default `reference/knowledge/wiki`), `QDRANT_URL`, `QDRANT_COLLECTION`.

## Notes

- Passage text is third-party content. The stack marks it untrusted and escapes a closing tag, but a retrieved page
  can still try to steer the model: keep the guardrail layer on for sources you do not control.
- `caller` (without its credential) reaches every source. A source enforcing per-user access reads it there.
