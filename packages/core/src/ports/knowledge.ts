import type { Attrs, Ext, PortBase } from './base.ts';
import type { Caller } from './identity.ts';

/** Equality filter on `attrs`; a list means any of. */
export type AttrFilter = Record<string, string | number | boolean | (string | number | boolean)[]>;

/** One retrieved unit of knowledge. Schema: spec/schemas/passage.json. */
export interface Passage {
  id: string;
  text: string;
  /** Instance name of the source; the core fills it when the adapter does not. */
  source: string;
  title?: string;
  url?: string;
  /** Higher is better. Comparable only within one source; after fusion, the fused score. */
  score?: number;
  /** Filterable attributes. */
  attrs?: Attrs;
  ext?: Ext;
}

export interface KnowledgeQuery {
  text: string;
  /** Passages wanted. */
  k?: number;
  filter?: AttrFilter;
  /** For per-user filtering. */
  caller?: Caller;
  signal?: AbortSignal;
  ext?: Ext;
}

/** Search a source of knowledge; every backend answers with Passages. */
export interface KnowledgePort extends PortBase {
  search(q: KnowledgeQuery): Promise<Passage[]>;
}

/** Who a memory belongs to. Every field narrows the scope; `caller` is the caller id. */
export interface MemoryScope { caller?: string; agent?: string; session?: string }

export interface MemoryItem { id?: string; text: string; attrs?: Attrs; ext?: Ext }

/** Long-term memory: what an agent keeps across sessions. */
export interface MemoryPort extends PortBase {
  remember(items: MemoryItem[], scope: MemoryScope): Promise<string[]>;
  recall(q: { text: string; k?: number; scope: MemoryScope; signal?: AbortSignal }): Promise<Passage[]>;
  forget(ids: string[], scope: MemoryScope): Promise<void>;
}

/** A document to load into a knowledge backend. Schema: spec/schemas/document.json. */
export interface Document { id: string; text: string; source?: string; title?: string; url?: string; attrs?: Attrs; ext?: Ext }

/** Load, refresh and delete documents in a knowledge backend. */
export interface IngestionPort extends PortBase {
  /** Inserts or replaces documents by id; resolves to the ids stored. */
  ingest(docs: Document[], opts?: { signal?: AbortSignal }): Promise<string[]>;
  delete(ids: string[], opts?: { signal?: AbortSignal }): Promise<void>;
}
