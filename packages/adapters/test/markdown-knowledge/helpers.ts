import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const FILES: Record<string, string> = {
  'ports.md': `Notes on the harbour towns of the Grey Strait.

# Port of Quillmere

Quillmere is a harbour town built on the Grey Strait.

## Tide gate

The tide gate of Quillmere closes at 14:20 every low tide to keep the brackish water out.
The gatekeeper is Orsolya Venn.

## Lighthouse

The beacon burns amber lamps from dusk. Quillmere ships its lamp oil from Dorrow.

### Keeper rota

Beacon keepers swap shifts every seventh day.

## Empty section

### Salt pans

Salt pans cover the eastern shore.
`,
  'guild/fishers.md': `# Fishers Guild

## Membership

Membership of the guild costs nine silver marks a year. Members may fish the Quillmere shallows.

## Harbour dues

Dues at the Quillmere harbour are paid in kelp rope, never in coin. The lighthouse is mentioned only once here.
`,
  'history/old/founding.md': `# Founding of Quillmere

Quillmere was founded in the year of the red tide by the sisters Anwen and Tarsa Holt.

## Tide gate repairs

The first tide gate collapsed twice before the stone one was set.
`,
  'notes.txt': '# Not markdown\n\nQuillmere in a text file.\n',
};

/** Writes files into a fresh temp dir. */
export async function tempDir(files: Record<string, string> = FILES): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'md-knowledge-'));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
