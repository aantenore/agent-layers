# IngestionPort

Layer: `knowledge` (L4 Knowledge & memory) · Version: 0.1.0 · Conformance: `checkIngestion`

## Purpose

Fill and maintain a knowledge backend: load documents, refresh them when they change, remove them when they are obsolete. It is the write side that [KnowledgePort](KnowledgePort.md) reads from.

## Operations

- `ingest(docs: [KnowledgeDocument], opts?: {signal?: Signal}) → [String]`
  Insert or replace documents by id. Returns the ids stored.
- `delete(ids: [String], opts?: {signal?: Signal}) → ()`
  Remove documents by id.

## Data shapes

[KnowledgeDocument](../schemas/knowledge-document.json): `id: String`, `text: String` (both required), `source?: String`, `metadata?: {String: Any}`.

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

`KnowledgeDocument.metadata` passes through to the backend. `native()` returns the backend client.

## Conformance

`checkIngestion` verifies:

- Fixture documents validate against `knowledge-document.json`.
- `ingest` returns one id per document.
- `delete` of the returned ids completes.

## Version history

- 0.1.0 — initial
