/** One heading section of a Markdown file. */
export interface Chunk {
  /** Path of headings, for example "Port of Quillmere > Tide gate". */
  heading: string;
  /** Text of the innermost heading. */
  name: string;
  /** Slug of the innermost heading, unique within the file. */
  slug: string;
  title: string;
  body: string;
}

const HEADING = /^(#{1,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^\s*(```|~~~)/;

export const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';

/**
 * Splits Markdown into chunks at `#`, `##` and `###` headings (fenced code is not scanned).
 * Text before the first heading belongs to a chunk named after the document title. Empty chunks are dropped.
 */
export function chunkMarkdown(markdown: string, fallbackTitle: string): Chunk[] {
  const sections: { path: string[]; lines: string[] }[] = [];
  const stack: { level: number; text: string }[] = [];
  let current = { path: [] as string[], lines: [] as string[] };
  let title: string | undefined;
  let fenced = false;
  sections.push(current);

  for (const line of markdown.replace(/^﻿/, '').split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced;
    const m = fenced ? null : HEADING.exec(line);
    if (!m) { current.lines.push(line); continue; }
    const level = m[1]!.length;
    const text = m[2]!;
    if (level === 1) title ??= text;
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, text });
    current = { path: stack.map((h) => h.text), lines: [] };
    sections.push(current);
  }

  const docTitle = title ?? fallbackTitle;
  const used = new Map<string, number>();
  const out: Chunk[] = [];
  for (const s of sections) {
    const body = s.lines.join('\n').trim();
    if (!body) continue;
    const path = s.path.length ? s.path : [docTitle];
    const base = slugify(path[path.length - 1]!);
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    out.push({ heading: path.join(' > '), name: path[path.length - 1]!, slug: n === 1 ? base : `${base}-${n}`, title: docTitle, body });
  }
  return out;
}
