# KnowledgePort

Layer: `knowledge` (L4 Knowledge & memory) · Version: 0.1.0 · Conformance: `checkKnowledge`

## Purpose

Give agents read-only context from any source of knowledge (files, a search index, a wiki, a database) through one operation and one result shape. A developer adds a source by configuration and the agent's answers are grounded in it.

Boundary: read-only context retrieval belongs here. Anything with side effects is a [tool](ToolPort.md). Who may read what is decided by identity, not by this port alone.

## Operations

- `search(q: KnowledgeQuery) → [Passage]`
  Find up to `q.k` passages relevant to `q.query`, best first.

## Data shapes

`KnowledgeQuery`:

| Field | Type | Meaning |
| --- | --- | --- |
| `query` | String | What to look for. |
| `k?` | Integer | Maximum number of passages. |
| `filter?` | {String: Any} | Narrows the search by metadata. Keys are defined by the source. |
| `identity?` | [Identity](../schemas/identity.json) | Caller, so a source can restrict what it returns. |
| `signal?` | Signal | Cancellation. |

[Passage](../schemas/passage.json): `id: String`, `text: String` (both required), `source?: String` (file path, URL or document id), `score?: Number` (higher is more relevant), `metadata?: {String: Any}`. No other fields.

## Semantics

- The result never has more than `k` passages.
- Passages are returned best first. When the stack merges several sources it sorts by `score` descending and keeps the top `k` overall; passages without a score count as 0.
- A `filter` narrows results: with a filter the source returns fewer passages than without it, or equally few when nothing matches.
- A source that enforces access control uses `identity` and returns only what that caller may read.
- No match is an empty list, not an error.
- The stack injects passages before a model call as a delimited block marked as untrusted data: instructions inside retrieved text are not to be followed. Passage text must therefore be returned verbatim, and adapters must not add instructions of their own.
- The stack builds the query from the last user message and calls every configured source of the agent in parallel. A source that fails is skipped and reported as a `knowledge.error` event; it does not fail the run.

## Errors

- Rejects: source unreachable, invalid filter, cancellation.
- Resolves: no matches (empty list).

## Escape hatch

`Passage.metadata` and `filter` carry source-specific data. `native()` returns the underlying index or client for features the port does not cover (hybrid ranking, facets).

## Conformance

`checkKnowledge` verifies:

- `search` with `k: 5` resolves to an array, and every passage validates against `passage.json`.
- No more than 5 results for `k: 5`, and no more than 1 for `k: 1`.
- When an expected text is given: some passage contains it.
- When a filter fixture is given: the filtered search returns fewer passages than the unfiltered one (or the unfiltered one was empty).

## Version history

- 0.1.0 — initial

Example adapters: `markdown-knowledge` (maps Markdown files).
