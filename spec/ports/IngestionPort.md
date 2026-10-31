# IngestionPort

Layer: `knowledge` (L4 Knowledge & memory) · Version: 1.0.0 · Conformance: `checkIngestion`

## Purpose

Fill and maintain a knowledge backend: load documents, refresh them when they change, remove them when they are obsolete. It is the write side that [KnowledgePort](KnowledgePort.md) reads from.

## Operations

- `ingest(docs: [Document], opts?: {signal?: Signal}) → [String]`
  Insert or replace documents by id. Returns the ids stored.
- `delete(ids: [String], opts?: {signal?: Signal}) → ()`
  Remove documents by id.

## Data shapes

[Document](../schemas/document.json):

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | String, required | Document id. |
| `text` | String, required | Content to index. |
| `source?` | String | Where the document comes from. |
| `title?` | String | Human title. |
| `url?` | String | Where the document lives. |
| `attrs?` | [Attrs](README.md#language) | Filterable attributes; they come back on the passages. |
| `ext?` | Ext | Backend-specific fields. |

## Semantics

- Upsert by id: ingesting a document with an existing id replaces it. Ingesting the same batch twice leaves the backend in the same state.
- `ingest` returns one id per input document, in input order.
- Chunking, embedding and indexing are the adapter's concern. After `ingest` resolves, documents are findable through the matching KnowledgePort, unless the adapter documents eventual consistency.
- `delete` of an id that does not exist is not an error.
- `signal` cancels a batch; a cancelled batch may be partially applied, and ingesting it again completes it.

## Errors

- Rejects: backend unreachable, a document the backend cannot store, cancellation.
- Resolves: nothing to do (empty list gives an empty result).

## Escape hatch

`Document.ext` passes through to the backend; keys are namespaced and declared in the adapter descriptor's `ext.produces` / `ext.reads`. `native()` returns the backend client. Mapping a document's fields to the backend's payload goes through the stack config `mappings` block; see [Mappings](../language.md#mappings).

## Conformance

`checkIngestion` verifies:

- Fixture documents validate against `document.json`.
- `ingest` returns one id per document.
- `delete` of the returned ids completes.
- `ext` keys written by the adapter are namespaced, in its namespace and declared (`checkExt`).

## Version history

- 1.0.0 — SDK language 1.0 ([0001](../../docs/decisions/0001-sdk-language.md)): `Document` (was `KnowledgeDocument`) with `title`, `url`, `attrs` instead of `metadata`
- 0.1.0 — initial
