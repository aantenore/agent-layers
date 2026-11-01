// Shared helpers for the repository scripts. Zero dependencies.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Hidden folders (local tool state, caches, .git) are skipped too, except .github.
const SKIP_DIRS = new Set(['node_modules', 'dist', '__pycache__']);
const skipDir = (name) => SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.github');

/** Adapter packages ship TypeScript behind the `@agent-layers/source` export condition. Re-run under it when it is missing. */
export function ensureSourceCondition(scriptUrl) {
  const active = process.execArgv.some((a) => a === '--conditions=@agent-layers/source' || a === '-C=@agent-layers/source')
    || /(--conditions=@agent-layers\/source|-C @agent-layers\/source)/.test(process.env.NODE_OPTIONS ?? '');
  if (active) return;
  const res = spawnSync(process.execPath, ['--conditions=@agent-layers/source', '--disable-warning=ExperimentalWarning', fileURLToPath(scriptUrl), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

export const rel = (path) => relative(ROOT, path).split('\\').join('/');
export const read = (path) => readFileSync(path, 'utf8');
export const readJson = (path) => JSON.parse(read(path));
export const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Workspace folders from the root `workspaces` globs (only the `dir/*` form is used here). */
export function workspaces() {
  const out = [];
  for (const pattern of readJson(join(ROOT, 'package.json')).workspaces ?? []) {
    const base = pattern.replace(/\/\*$/, '');
    const dirs = pattern.endsWith('/*') ? readdirSync(join(ROOT, base)).sort().map((d) => `${base}/${d}`) : [pattern];
    for (const dir of dirs) if (existsSync(join(ROOT, dir, 'package.json'))) out.push(dir);
  }
  return out;
}

/** Every file under `dir` (absolute paths), skipping build output and vendored folders. */
export function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries.sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { if (!skipDir(name)) walk(full, out); }
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
