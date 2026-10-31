# MemoryPort

Layer: `knowledge` (L4 Knowledge & memory) · Version: 0.1.0 · Conformance: `checkMemory`

## Purpose

Let an agent keep facts across sessions and bring back the relevant ones later, scoped to a person, an agent or a session. Recall returns the same passages as [KnowledgePort](KnowledgePort.md), so memory can feed the same injection path.

## Operations

- `remember(items: [MemoryItem], scope: MemoryScope) → [String]`
  Store the items under the scope and return their ids, one per item, in order.
- `recall(q: {query: String, k?: Integer, scope: MemoryScope, signal?: Signal}) → [Passage]`
  Return the stored items most relevant to the query within the scope, best first.
- `forget(ids: [String], scope: MemoryScope) → ()`
  Remove items by id within the scope.

## Data shapes

- `MemoryScope`: `subject?: String`, `agent?: String`, `session?: String`. Every field present narrows the scope.
- `MemoryItem`: `id?: String`, `text: String`, `metadata?: {String: Any}`. When `id` is given it is used; otherwise the store assigns one.
- Recall results are [Passage](../schemas/passage.json) values.

## Semantics

- Scope is a hard boundary. A recall under one `subject` must never return items stored under another subject. The same holds for `agent` and `session` when they are set.
- `remember` returns exactly as many ids as items.
- After `forget`, the item is no longer recalled in that scope. Forgetting an id outside the scope does not remove it.
- `recall` honours `k` and may return fewer passages. No match is an empty list.
- Memory content is user data; it is retrieved as untrusted text, like any knowledge passage.
- Whether and when to write memory is the runtime's decision; the port only stores and retrieves.

## Errors

- Rejects: store unreachable, cancellation, invalid scope (for example empty).
- Resolves: empty recall.

## Escape hatch

`MemoryItem.metadata` and `Passage.metadata` pass through. `native()` returns the memory backend client.

## Conformance

`checkMemory` verifies:

- `remember` of one item returns one id.
- `recall` in the same scope finds the item; each recalled passage validates against `passage.json`.
- `recall` under a different subject does not return it (no leaks across subjects).
- After `forget`, the item is no longer recalled.

## Version history

- 0.1.0 — initial
