// Shared helpers for the docs scripts. Zero dependencies.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const SKIP_DIRS = new Set(['node_modules', '.git', '.terraform', '.claude', 'dist', '.agent-layers']);

/** Adapter packages ship TypeScript behind the `source` export condition. Re-run under it when it is missing. */
export function ensureSourceCondition(scriptUrl) {
  const active = process.execArgv.some((a) => a === '--conditions=source' || a === '-C=source')
    || /(--conditions=source|-C source)/.test(process.env.NODE_OPTIONS ?? '');
  if (active) return;
  const res = spawnSync(process.execPath, ['--conditions=source', '--disable-warning=ExperimentalWarning', fileURLToPath(scriptUrl), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

export const rel = (path) => relative(ROOT, path).split('\\').join('/');
export const read = (path) => readFileSync(path, 'utf8');

/** Every file under `dir` (absolute paths), skipping build output and vendored folders. */
export function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries.sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Imports a TypeScript module of the repository (Node strips the types). */
export const importSource = (path) => import(pathToFileURL(resolve(ROOT, path)).href);

/** Lines of a Markdown file with fenced code blocks replaced by `null`, so line numbers stay right. */
export function proseLines(text) {
  let fence = null;
  return text.split('\n').map((line) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      return null;
    }
    return fence ? null : line;
  });
}
