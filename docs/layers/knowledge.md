# L4 Knowledge & memory (`knowledge`)

## Responsibility

Give agents information that is not in the model. That is more than RAG over documents: it includes structured data,
graphs and ontologies, a curated wiki, long-term memory and procedural know-how. Retrieval returns passages; the
runtime decides how to present them.

## Standard

There is no single standard, because the sources differ:

| Knowledge type | Query standard |
|---|---|
| Documents | none; each vector database has its own API |
| Structured data | SQL |
| Graphs and ontologies | SPARQL + RDF / OWL / SKOS (W3C); ISO GQL, Cypher |
| Curated wiki | files + git |
| Long-term memory | none |
| Procedural know-how | Agent Skills |

**Transport is standardised, the result is not.** MCP defines how an agent reaches a source (tools, resources). It
does not define what a search returns: every MCP server answers in its own shape. So L3 has two parts:

- **Transport:** MCP, HTTP or a JS function.
- **Result contract:** `KnowledgeSource.search → Passage { id, text, source, score, metadata }`.

Adapters translate each backend into `Passage`. The uniform result is what lets [telemetry](telemetry.md) trace and
[eval](eval.md) evaluate retrieval quality the same way for every backend.

## Extension point

`KnowledgeSource.search({ query, k, filter, identity }) → Passage[]`. A source can be an MCP tool, an HTTP endpoint
or a JS function.

## Reference implementation

| Source | Adapter | Reference | License | Status |
|---|---|---|---|---|
| Documents (vector) | `mcpKnowledge` | Qdrant + mcp-server-qdrant (`qdrant-find`) | Apache-2.0 / Apache-2.0 | now |
| Any HTTP search service | `httpKnowledge` | `POST {url}` returning passages | - | now |
| Curated wiki | `wikiKnowledge` | Markdown folder (`WIKI_DIR`), zero infra | - | now |
| Structured data | `sqlKnowledge` | MCP Toolbox for Databases | Apache-2.0 | next |
| Graphs and ontologies | `sparqlKnowledge` | SPARQL 1.1 Protocol; Apache Jena Fuseki | Apache-2.0 | next |
| Property graphs | graph adapter | Cypher / GQL (for example Neo4j; its Community edition is GPL-3.0, so it is a target, not a reference) | - | next |
| Long-term memory | `memoryKnowledge` | to be chosen | - | next |

## Adapter SDK + conformance

`KnowledgeSource` plus a conformance check. It indexes a small fixed corpus, queries it, and verifies that results
validate against [passage.json](../../spec/schemas/passage.json), respect `k`, and that a filter narrows the result. A
new backend is supported when its adapter passes.

## Around the layer

- **Ingestion.** Docling (MIT) converts PDF, DOCX and other formats to Markdown or chunks before they are indexed.
  Described, not wired into the tests.
- **Long-term memory.** What the agent learns across sessions, exposed as a `KnowledgeSource` like any other.
- **Optional GraphRAG.** Graphiti (Apache-2.0) and LightRAG (MIT) build a graph from documents and answer from it.
  They sit behind an adapter; nothing in the contract changes.

## How to swap it

- Any MCP server whose tool returns passages works with a thin `mcpKnowledge` mapping.
- Any HTTP service implementing `POST {url} {query,k,filter}` → `{passages}` works with `httpKnowledge`, no code.
- Anything else is a JS function implementing `KnowledgeSource`.

## Contract

```ts
interface KnowledgeSource { search(q: { query: string; k?: number; filter?: object; identity?: Identity }): Promise<Passage[]> }
interface Passage { id: string; text: string; source?: string; score?: number; metadata?: object }
```

Schema: [passage.json](../../spec/schemas/passage.json). Details in the port spec: [KnowledgePort](../../spec/ports/KnowledgePort.md), [MemoryPort](../../spec/ports/MemoryPort.md) and [IngestionPort](../../spec/ports/IngestionPort.md).

The reinloop `knowledge` middleware injects the top-k passages as a delimited block marked untrusted, so retrieved
text is data and not instructions (see [security](../cross-cutting/security.md)).

## How to test

```bash
make up LAYER=l3-knowledge
make test LAYER=l3-knowledge
make down LAYER=l3-knowledge
```

Variables: `QDRANT_URL`, `QDRANT_COLLECTION`, `WIKI_DIR`. The wiki tests run without Docker.
