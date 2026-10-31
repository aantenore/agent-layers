// Loads Markdown files into Qdrant through mcp-server-qdrant's `qdrant-store`, one point per heading section.
//
//   node reference/knowledge/scripts/ingest.mjs [dir ...] [--append]
//
// Default dir: reference/knowledge/docs. The collection is recreated first so repeated runs do not pile up duplicates;
// pass --append to keep what is there. Each point carries metadata { id, path, heading }, and `id` is what
// the retrieval side reports as the passage id.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reinloop } from '../../../lib/reinloop.mjs';
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

if (!append) {
  const res = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`cannot reset collection ${QDRANT_COLLECTION}: HTTP ${res.status}`);
}

const client = await reinloop.McpClient.connect('qdrant', qdrantServer);
let stored = 0;
try {
  for (const dir of dirs) {
    for (const file of await markdownFiles(dir)) {
      const rel = relative(dir, file);
      for (const p of reinloop.splitMarkdown(await readFile(file, 'utf8'), rel)) {
        const res = await client.callTool('qdrant-store', { information: p.text, metadata: { id: p.id, ...p.metadata } });
        if (res.isError) throw new Error(`qdrant-store failed for ${p.id}: ${res.content}`);
        stored++;
      }
    }
  }
} finally {
  await client.close();
}
console.log(`stored ${stored} passages in "${QDRANT_COLLECTION}" at ${QDRANT_URL}`);
