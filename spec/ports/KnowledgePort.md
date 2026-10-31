# KnowledgePort

Layer: `knowledge` (L4 Knowledge & memory) · Version: 1.0.0 · Conformance: `checkKnowledge`

## Purpose

Give agents read-only context from any source of knowledge (files, a search index, a wiki, a database) through one operation and one result shape. A developer adds a source by configuration and the agent's answers are grounded in it.

Boundary: read-only context retrieval belongs here. Anything with side effects is a [tool](ToolPort.md). Who may read what is decided by identity, not by this port alone.

## Operations

- `search(q: KnowledgeQuery) → [Passage]`
  Find up to `q.k` passages relevant to `q.text`, best first.

## Data shapes

`KnowledgeQuery`:

| Field | Type | Meaning |
| --- | --- | --- |
| `text` | String, required | What to look for. |
| `k?` | Integer | Maximum number of passages. |
| `filter?` | {String: String \| Number \| Boolean \| [String]} | Equality on the passages' `attrs`; a list means any of. |
| `caller?` | [Caller](../schemas/caller.json) | Who asks, so a source can restrict what it returns. |
| `signal?` | Signal | Cancellation. |
| `ext?` | Ext | Source-specific query options. |

[Passage](../schemas/passage.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | String, required | Passage id. |
| `text` | String, required | The passage, verbatim. |
| `source` | String, required | Instance name of the source (the configuration key). The core fills it when the adapter does not. |
| `title?` | String | Human title of the document. |
| `url?` | String | Where the document lives. |
| `score?` | Number | Higher is more relevant. Comparable only within one source. |
| `attrs?` | [Attrs](README.md#language) | Filterable attributes (language, owner, tags). |
| `ext?` | Ext | Source-specific fields. |

## Semantics

- The result never has more than `k` passages.
- Passages are returned best first. A source's `score` has meaning only inside that source: BM25 is unbounded, a vector store returns a similarity or a distance.
- Fusion across sources: when the stack merges passages from two or more sources it uses reciprocal rank fusion (RRF). The fused score of a passage is the sum over sources of `weight / (rrfK + rank)`, with `rank` starting at 1, `rrfK = 60` by default and weights per source from the configuration (`pipeline.knowledge.fusion`). The stack keeps the top `k` overall.
- Duplicates (same `source` and `id`) are kept once, at their best rank. Ties break on rank, then source order in the configuration, then `id`.
- After fusion `score` is the fused score. The core writes the source's own score to `ext["sdk.raw_score"]` and its rank to `ext["sdk.rank"]`. With one source its order is kept and `score` and `ext` are written the same way.
- `method: "raw"` is an opt-in for owners whose sources share one scorer: passages are sorted by raw `score` descending, passages without a score count as 0, and the raw score and rank are written to `ext` the same way.
- Knowledge exposed as tools (one tool per source) is not fused.
- A `filter` narrows results: with a filter the source returns fewer passages than without it, or equally few when nothing matches.
- A source that enforces access control uses `caller` and returns only what that caller may read.
- No match is an empty list, not an error.
- The stack injects passages before a model call as a delimited block marked as untrusted data: instructions inside retrieved text are not to be followed. Passage text must therefore be returned verbatim, and adapters must not add instructions of their own.
- The stack builds the query from the last user message and calls every configured source of the agent in parallel. A source that fails is skipped and reported as an `agent.knowledge.error` event; it does not fail the run.

## Errors

- Rejects: source unreachable, invalid filter, cancellation.
- Resolves: no matches (empty list).

## Escape hatch

`ext` on the query and on passages carries source-specific data (keys like `qdrant.collection`), namespaced and declared in the adapter descriptor's `ext.produces` / `ext.reads`; the core copies it and never reads it. `native()` returns the underlying index or client for features the port does not cover (hybrid ranking, facets). Mapping a source's own metadata to `title`, `url` and `attrs` goes through the stack config `mappings` block (`knowledge.<name>`); see [Mappings](../language.md#mappings).

## Conformance

`checkKnowledge` verifies:

- `search` with `k: 5` resolves to an array, and every passage validates against `passage.json`.
- No more than 5 results for `k: 5`, and no more than 1 for `k: 1`.
- When an expected text is given: some passage contains it.
- When a filter fixture is given: the filtered search returns fewer passages than the unfiltered one (or the unfiltered one was empty).
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): `KnowledgeQuery.text` and `caller`; `filter` on `attrs`; `Passage` has required `source`, `title`, `url`, `attrs` (replaces `metadata`); multi-source results are fused by reciprocal rank
- 0.1.0 — initial

Example adapters: `markdown-knowledge` (maps Markdown files).
