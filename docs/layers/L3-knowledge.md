# L3 Knowledge

## Purpose

Give agents access to information that is not in the model: documents, wikis, vector stores. Retrieval returns
passages; the harness decides how to present them.

## Standard

MCP tools and resources.

## Extension point

`KnowledgeSource.search({ query, k, filter, identity }) → Passage[]`. A source can be an MCP tool, an HTTP
endpoint or a JS function.

## Reference implementation

| Role | Reference | License |
|---|---|---|
| Vector search | Qdrant + mcp-server-qdrant (`qdrant-find`) | Apache-2.0 / Apache-2.0 |
| Zero-infra | Markdown "LLM wiki" folder (`WIKI_DIR`) | - |
| Ingestion (docs only) | Docling | MIT |

The wiki source reads Markdown files from a folder and needs no service at all. Docling converts PDF, DOCX and
other formats to Markdown or chunks before they are indexed; it is described, not wired into the tests.

## How to swap it

- Any MCP server whose tool returns passages works with no code.
- Any HTTP service implementing `POST {url} {query,k,filter}` → `{passages}` works with no code.
- Anything else is a JS function implementing `KnowledgeSource`.

## Contract

```ts
interface KnowledgeSource { search(q: { query: string; k?: number; filter?: object; identity?: Identity }): Promise<Passage[]> }
interface Passage { id: string; text: string; source?: string; score?: number; metadata?: object }
```

Schema: [passage.json](../../contracts/passage.json). Details in [contracts.md](../contracts.md#l3-knowledge).

The reinloop `knowledge` middleware injects the top-k passages as a delimited block marked untrusted, so retrieved
text is data and not instructions.

## Adapter SDK

`KnowledgeSource` plus a conformance check: it indexes a small fixed corpus, queries it, and verifies that results
validate against `passage.json`, respect `k`, and that a filter narrows the result.

## How to test

```bash
make up LAYER=l3-knowledge
make test LAYER=l3-knowledge
make down LAYER=l3-knowledge
```

Variables: `QDRANT_URL`, `QDRANT_COLLECTION`, `WIKI_DIR`. The wiki tests run without Docker.
