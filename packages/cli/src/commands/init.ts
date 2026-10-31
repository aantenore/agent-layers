import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, type Io } from '../io.ts';

const TEMPLATES_DIR = fileURLToPath(new URL('../../templates/', import.meta.url));

/** Template name → folders copied in order (later ones overlay earlier ones). */
const TEMPLATES: Record<string, string[] | 'planned'> = {
  minimal: ['minimal'],
  rag: ['minimal', 'rag'],
  tools: 'planned',
  'multi-agent': 'planned',
};

const RENAMES: Record<string, string> = { _gitignore: '.gitignore', '_env.example': '.env.example' };

export interface InitArgs { dir?: string; template?: string; runtime?: string; name?: string; agent?: string; force?: boolean; yes?: boolean }

const version = () => (JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string }).version;

/** Scaffolds an agent project with all eleven layers wired. Refuses a non-empty folder without --force. */
export async function init(io: Io, args: InitArgs): Promise<number> {
  const template = args.template ?? 'minimal';
  const layers = TEMPLATES[template];
  if (!layers) throw new UsageError(`unknown template "${template}" (available: ${Object.keys(TEMPLATES).filter((t) => TEMPLATES[t] !== 'planned').join(', ')})`);
  if (layers === 'planned') throw new UsageError(`template "${template}" is planned; available now: minimal, rag`);
  const dir = resolve(io.cwd, args.dir ?? '.');
  if (existsSync(dir) && readdirSync(dir).length && !args.force) throw new UsageError(`${dir} is not empty (use --force to write into it)`);
  const name = (args.name ?? basename(dir)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const agent = args.agent ?? 'assistant';
  if (!/^[a-z][a-z0-9-]*$/.test(agent)) throw new UsageError('--agent must be lowercase letters, digits and dashes');
  const values: Record<string, string> = { name, agent, runtime: args.runtime ?? 'basic-runtime', version: version() };

  await mkdir(dir, { recursive: true });
  for (const layer of layers) await cp(join(TEMPLATES_DIR, layer), dir, { recursive: true, force: true });
  const written: string[] = [];
  for (const file of await walk(dir)) {
    const rel = relative(dir, file);
    let target = fill(file, values);
    const base = basename(target);
    if (RENAMES[base]) target = join(target, '..', RENAMES[base]);
    const text = await readFile(file, 'utf8');
    await writeFile(file, fill(text, values));
    if (target !== file) await rename(file, target);
    written.push(relative(dir, target) || rel);
  }
  io.out(`Created ${name} (${template}) in ${dir}: ${written.length} files, all eleven layers wired.`);
  io.out(`Next:\n  cd ${relative(io.cwd, dir) || '.'}\n  npm install\n  npx agent-layers check\n  npx agent-layers dev`);
  return 0;
}

/** Replaces known {{placeholders}} only; others (such as capture groups {{1}}) stay. */
function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(name|agent|runtime|version)\}\}/g, (_m, k: string) => values[k]!);
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}
