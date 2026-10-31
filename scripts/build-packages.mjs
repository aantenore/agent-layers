// Builds every workspace that has a `build` script, dependencies first, so a clean checkout builds in one command.
// `npm run build --workspaces` follows the folder order instead, which builds adapters before the core they import.
//   node scripts/build-packages.mjs           build in dependency order
//   node scripts/build-packages.mjs --clean   remove dist/ first
//   node scripts/build-packages.mjs --list    print the order and exit
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/common.mjs';

const args = new Set(process.argv.slice(2));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Workspace folders from the root `workspaces` globs (only the `dir/*` form is used here). */
function workspaces() {
  const out = [];
  for (const pattern of readJson(join(ROOT, 'package.json')).workspaces ?? []) {
    const base = pattern.replace(/\/\*$/, '');
    const dirs = pattern.endsWith('/*') ? readdirSync(join(ROOT, base)).sort().map((d) => `${base}/${d}`) : [pattern];
    for (const dir of dirs) if (existsSync(join(ROOT, dir, 'package.json'))) out.push(dir);
  }
  return out;
}

/** Topological order over runtime and peer dependencies between workspaces; fails on a cycle. */
function order(dirs) {
  const pkgs = new Map(dirs.map((dir) => [readJson(join(ROOT, dir, 'package.json')).name, dir]));
  const deps = (dir) => {
    const p = readJson(join(ROOT, dir, 'package.json'));
    return Object.keys({ ...p.dependencies, ...p.peerDependencies, ...p.optionalDependencies }).filter((n) => pkgs.has(n));
  };
  const done = new Set();
  const visiting = new Set();
  const out = [];
  const visit = (name, path) => {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`dependency cycle: ${[...path, name].join(' -> ')}`);
    visiting.add(name);
    for (const dep of deps(pkgs.get(name))) visit(dep, [...path, name]);
    visiting.delete(name);
    done.add(name);
    out.push(pkgs.get(name));
  };
  for (const name of pkgs.keys()) visit(name, []);
  return out;
}

const buildable = order(workspaces()).filter((dir) => readJson(join(ROOT, dir, 'package.json')).scripts?.build);
if (args.has('--list')) {
  console.log(buildable.join('\n'));
  process.exit(0);
}
for (const dir of buildable) {
  if (args.has('--clean')) rmSync(join(ROOT, dir, 'dist'), { recursive: true, force: true });
  const res = spawnSync(npm, ['run', 'build', '--silent', '--workspace', dir], { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`build failed: ${dir}`);
    process.exit(res.status ?? 1);
  }
}
console.log(`built ${buildable.length} packages`);
