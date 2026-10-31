import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { defineAdapter, matchesAny, PORT_VERSIONS, type KnowledgePort, type Passage } from '@agent-layers/core';
import { chunkMarkdown } from './chunk.ts';
import { Bm25, indexDoc, tokenize } from './rank.ts';

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

interface Entry { passage: Omit<Passage, 'score'>; source: string }
interface Index { entries: Entry[]; bm25: Bm25 }

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

async function buildIndex(root: string, extensions: readonly string[]): Promise<Index> {
  const entries: Entry[] = [];
  const docs: ReturnType<typeof indexDoc>[] = [];
  for (const rel of await listFiles(root, extensions)) {
    const markdown = await readFile(resolve(root, rel), 'utf8');
    for (const chunk of chunkMarkdown(markdown, basename(rel, extname(rel)))) {
      entries.push({
        source: rel,
        passage: {
          id: `${rel}#${chunk.slug}`,
          text: `${chunk.heading}\n\n${chunk.body}`,
          source: rel,
          metadata: { file: rel, heading: chunk.heading, title: chunk.title },
        },
      });
      docs.push(indexDoc(chunk.heading, chunk.name, chunk.body));
    }
  }
  return { entries, bm25: new Bm25(docs) };
}

/** Factory: usable directly from code, without the registry. */
export function createMarkdownKnowledge(
  options: MarkdownKnowledgeOptions,
  { cwd = process.cwd(), name = 'markdown-knowledge' }: { cwd?: string; name?: string } = {},
): MarkdownKnowledge {
  const root = resolve(cwd, options.dir);
  const extensions = (options.extensions ?? ['.md']).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
  let index: Promise<Index> | undefined;

  return {
    name,
    async search(q) {
      q.signal?.throwIfAborted();
      const terms = [...new Set(tokenize(q.query))];
      if (!terms.length) return [];
      const idx = await (index ??= buildIndex(root, extensions).catch((err) => { index = undefined; throw err; }));
      const source = q.filter?.source;
      const globs = typeof source === 'string' ? [source] : Array.isArray(source) ? source.filter((s): s is string => typeof s === 'string') : undefined;
      const scored: Passage[] = [];
      idx.entries.forEach((e, i) => {
        if (globs && !matchesAny(globs, e.source)) return;
        const score = idx.bm25.score(i, terms);
        if (score > 0) scored.push({ ...e.passage, score });
      });
      return scored.sort((a, b) => b.score! - a.score! || a.id.localeCompare(b.id)).slice(0, Math.max(0, q.k ?? options.k ?? 4));
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
      k: { type: 'integer', minimum: 1 },
    },
    required: ['dir'],
    additionalProperties: false,
  },
  create: (options, ctx) => createMarkdownKnowledge(options, { cwd: ctx.cwd, name: ctx.name }),
});

export const adapters = [adapter];
