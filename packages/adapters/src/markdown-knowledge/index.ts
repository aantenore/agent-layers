import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import {
  defineAdapter, defineLimits, limitProperties, limitValue, matchesAny, noMappings, PORT_VERSIONS, type AttrFilter, type Attrs, type KnowledgePort, type Mappings,
  type Passage,
} from '@agent-layers/core';
import { chunkMarkdown } from './chunk.ts';
import { Bm25, indexDoc, tokenize } from './rank.ts';

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  k: { path: 'options.k', default: 4, unit: 'count', min: 1, safe: { max: 50 } },
});

/** Options, validated against `optionsSchema` before `create` runs. */
export interface MarkdownKnowledgeOptions {
  /** Directory with the Markdown files, relative to the stack config directory. */
  dir: string;
  /** File extensions to load (default `.md`). */
  extensions?: string[];
  /** Passages returned when the query has no `k` (default 4). */
  k?: number;
}

export type MarkdownKnowledge = KnowledgePort & {
  /** Drops the cache; the files are read again on the next search. */
  refresh(): Promise<void>;
};

interface Index { passages: Omit<Passage, 'score'>[]; bm25: Bm25 }

/** What one chunk looks like before it becomes a passage: the source document of the `in` mapping rules. */
export interface MarkdownChunk { file: string; slug: string; heading: string; title: string; body: string }

/**
 * True when the passage's attributes satisfy the filter: every key must be present; a string value is a glob over a
 * string attribute (or any element of a list attribute), other values compare equal; a list means any of.
 */
export function matchesFilter(attrs: Attrs | undefined, filter: AttrFilter | undefined): boolean {
  if (!filter) return true;
  for (const [key, wanted] of Object.entries(filter)) {
    const have = attrs?.[key];
    if (have === undefined) return false;
    const values = Array.isArray(have) ? have : [have];
    const ok = (Array.isArray(wanted) ? wanted : [wanted]).some((w) =>
      values.some((v) => (typeof w === 'string' && typeof v === 'string' ? matchesAny([w], v) : v === w)));
    if (!ok) return false;
  }
  return true;
}

/** Relative POSIX paths of the matching files below `root`, dot-directories skipped, sorted. */
async function listFiles(root: string, extensions: readonly string[]): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`markdown-knowledge: directory not found: ${root}`);
    throw err;
  }
  return entries
    .filter((e) => e.isFile() && extensions.includes(extname(e.name).toLowerCase()))
    .map((e) => resolve(e.parentPath, e.name).slice(root.length + 1).split(sep).join('/'))
    .filter((rel) => !rel.split('/').some((part) => part.startsWith('.')))
    .sort();
}

async function buildIndex(root: string, extensions: readonly string[], source: string, mappings: Mappings): Promise<Index> {
  const passages: Omit<Passage, 'score'>[] = [];
  const docs: ReturnType<typeof indexDoc>[] = [];
  for (const rel of await listFiles(root, extensions)) {
    const markdown = await readFile(resolve(root, rel), 'utf8');
    for (const chunk of chunkMarkdown(markdown, basename(rel, extname(rel)))) {
      const native: MarkdownChunk = { file: rel, slug: chunk.slug, heading: chunk.heading, title: chunk.title, body: chunk.body };
      passages.push(mappings.in(native, {
        id: `${rel}#${chunk.slug}`,
        text: `${chunk.heading}\n\n${chunk.body}`,
        source,
        title: chunk.title,
        attrs: { file: rel, heading: chunk.heading },
      }));
      docs.push(indexDoc(chunk.heading, chunk.name, chunk.body));
    }
  }
  return { passages, bm25: new Bm25(docs) };
}

/** Factory: usable directly from code, without the registry. */
export function createMarkdownKnowledge(
  options: MarkdownKnowledgeOptions,
  { cwd = process.cwd(), name = 'markdown-knowledge', mappings = noMappings() }: { cwd?: string; name?: string; mappings?: Mappings } = {},
): MarkdownKnowledge {
  const root = resolve(cwd, options.dir);
  const defaultK = limitValue(LIMITS.k, options.k);
  const extensions = (options.extensions ?? ['.md']).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
  let index: Promise<Index> | undefined;

  return {
    name,
    async search(q) {
      q.signal?.throwIfAborted();
      const terms = [...new Set(tokenize(q.text))];
      if (!terms.length) return [];
      const idx = await (index ??= buildIndex(root, extensions, name, mappings).catch((err) => { index = undefined; throw err; }));
      const scored: Passage[] = [];
      idx.passages.forEach((p, i) => {
        if (!matchesFilter(p.attrs, q.filter)) return;
        const score = idx.bm25.score(i, terms);
        if (score > 0) scored.push({ ...p, score });
      });
      return scored.sort((a, b) => b.score! - a.score! || a.id.localeCompare(b.id)).slice(0, Math.max(0, q.k ?? defaultK));
    },
    async refresh() {
      index = undefined;
    },
    native: () => ({ dir: root, extensions }),
  };
}

/** Descriptor: what the registry and the CLI see. */
export const adapter = defineAdapter<'KnowledgePort', MarkdownKnowledgeOptions>({
  layer: 'knowledge',
  port: 'KnowledgePort',
  name: 'markdown-knowledge',
  direction: 'outbound',
  maps: { technology: 'Markdown files' },
  portVersion: PORT_VERSIONS.KnowledgePort,
  tiers: ['prototype', 'production'],
  description: 'Searches a directory of Markdown files, chunked by heading and ranked with BM25.',
  optionsSchema: {
    type: 'object',
    properties: {
      dir: { type: 'string', minLength: 1 },
      extensions: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
      ...limitProperties(LIMITS, { k: 'Passages returned when the query has no k' }),
    },
    required: ['dir'],
    additionalProperties: false,
  },
  limits: LIMITS,
  ext: { produces: [] },
  mappingDefaults: { in: { shape: 'Passage' } },
  create: (options, ctx) => createMarkdownKnowledge(options, { cwd: ctx.cwd, name: ctx.name, mappings: ctx.mappings }),
});

export const adapters = [adapter];
