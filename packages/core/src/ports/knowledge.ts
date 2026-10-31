import type { PortBase } from './base.ts';
import type { Identity } from './identity.ts';

/** One retrieved unit of knowledge. Schema: spec/schemas/passage.json. */
export interface Passage {
  id: string;
  text: string;
  source?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeQuery {
  query: string;
  k?: number;
  filter?: Record<string, unknown>;
  identity?: Identity;
  signal?: AbortSignal;
}

/** Search a source of knowledge; every backend answers with Passages. */
export interface KnowledgePort extends PortBase {
  search(q: KnowledgeQuery): Promise<Passage[]>;
}

/** Who a memory belongs to. Every field narrows the scope. */
export interface MemoryScope { subject?: string; agent?: string; session?: string }

export interface MemoryItem { id?: string; text: string; metadata?: Record<string, unknown> }

/** Long-term memory: what an agent keeps across sessions. */
export interface MemoryPort extends PortBase {
  remember(items: MemoryItem[], scope: MemoryScope): Promise<string[]>;
  recall(q: { query: string; k?: number; scope: MemoryScope; signal?: AbortSignal }): Promise<Passage[]>;
  forget(ids: string[], scope: MemoryScope): Promise<void>;
}

/** A document to load into a knowledge backend. */
export interface KnowledgeDocument { id: string; text: string; source?: string; metadata?: Record<string, unknown> }

/** Load, refresh and delete documents in a knowledge backend. */
export interface IngestionPort extends PortBase {
  /** Inserts or replaces documents by id; resolves to the ids stored. */
  ingest(docs: KnowledgeDocument[], opts?: { signal?: AbortSignal }): Promise<string[]>;
  delete(ids: string[], opts?: { signal?: AbortSignal }): Promise<void>;
}
