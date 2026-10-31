// Loads Markdown files into Qdrant through mcp-server-qdrant's `qdrant-store`, one point per heading section.
//
//   node reference/knowledge/scripts/ingest.mjs [dir ...] [--append]
//
// Default dir: reference/knowledge/docs. The collection is recreated first so repeated runs do not pile up duplicates;
// pass --append to keep what is there. Each point carries metadata { id, path, heading }, and `id` is what
// the retrieval side reports as the passage id.
//
// The sections follow the markdown-knowledge adapter: split at `#`, `##` and `###` headings (fenced code is not
// scanned), id `<relative path>#<slug of the innermost heading>`, text `<heading path>\n\n<body>`.
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpSession } from '@agent-layers/adapter-mcp';
import { QDRANT_COLLECTION, QDRANT_URL, qdrantServer } from './qdrant-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const append = args.includes('--append');
const dirs = args.filter((a) => !a.startsWith('--'));
if (!dirs.length) dirs.push(join(here, '..', 'docs'));

async function markdownFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await markdownFiles(path)));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(path);
  }
  return out.sort();
}

const HEADING = /^(#{1,3})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^\s*(```|~~~)/;
const slugify = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';

/** One passage per heading section: { id, text, metadata }. */
function sections(markdown, rel) {
  const found = [{ path: [], lines: [] }];
  const stack = [];
  let title;
  let fenced = false;
  for (const line of markdown.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced;
    const m = fenced ? null : HEADING.exec(line);
    if (!m) { found.at(-1).lines.push(line); continue; }
    const level = m[1].length;
    if (level === 1) title ??= m[2];
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    stack.push({ level, text: m[2] });
    found.push({ path: stack.map((h) => h.text), lines: [] });
  }
  const used = new Map();
  const out = [];
  for (const s of found) {
    const body = s.lines.join('\n').trim();
    if (!body) continue;
    const path = s.path.length ? s.path : [title ?? basename(rel, extname(rel))];
    const base = slugify(path.at(-1));
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const heading = path.join(' > ');
    out.push({ id: `${rel}#${n === 1 ? base : `${base}-${n}`}`, text: `${heading}\n\n${body}`, metadata: { path: rel, heading } });
  }
  return out;
}

if (!append) {
  const res = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`cannot reset collection ${QDRANT_COLLECTION}: HTTP ${res.status}`);
}

const session = new McpSession(qdrantServer);
let stored = 0;
try {
  for (const dir of dirs) {
    for (const file of await markdownFiles(dir)) {
      const rel = relative(dir, file).split(sep).join('/');
      for (const p of sections(await readFile(file, 'utf8'), rel)) {
        const res = await session.run((c) => c.callTool('qdrant-store', { information: p.text, metadata: { id: p.id, ...p.metadata } }));
        if (res.isError) throw new Error(`qdrant-store failed for ${p.id}: ${res.text}`);
        stored++;
      }
    }
  }
} finally {
  await session.close();
}
console.log(`stored ${stored} passages in "${QDRANT_COLLECTION}" at ${QDRANT_URL}`);
