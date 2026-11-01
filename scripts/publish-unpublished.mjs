// Publishes every public workspace package whose current version is not on the registry yet, so a release that
// stopped halfway (rate limit, expired login) resumes where it stopped. Stops at the first failure.
//   node scripts/publish-unpublished.mjs                publish what is missing
//   node scripts/publish-unpublished.mjs --list         print what is missing and exit
//   node scripts/publish-unpublished.mjs --provenance   any other flag is passed to `npm publish`
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { npm, readJson, ROOT, workspaces } from './lib/common.mjs';

const args = process.argv.slice(2);
const list = args.includes('--list');
const publishArgs = args.filter((a) => a !== '--list');

/** True when `name@version` is already on the registry; a 404 (package or version unknown) is false. */
function published(name, version) {
  const res = spawnSync(npm, ['view', `${name}@${version}`, 'version'], { cwd: ROOT, encoding: 'utf8' });
  if (res.status === 0) return res.stdout.trim() !== '';
  if (/E404|404 Not Found/.test(res.stderr)) return false;
  throw new Error(`npm view ${name}@${version} failed:\n${res.stderr.trim()}`);
}

const missing = workspaces()
  .map((dir) => ({ dir, pkg: readJson(join(ROOT, dir, 'package.json')) }))
  .filter(({ pkg }) => !pkg.private)
  .filter(({ pkg }) => !published(pkg.name, pkg.version));

if (list || missing.length === 0) {
  for (const { pkg } of missing) console.log(`${pkg.name}@${pkg.version}`);
  console.log(`${missing.length} package(s) not on the registry`);
  process.exit(0);
}
for (const [i, { dir, pkg }] of missing.entries()) {
  console.log(`[${i + 1}/${missing.length}] ${pkg.name}@${pkg.version}`);
  const res = spawnSync(npm, ['publish', '--workspace', dir, '--access', 'public', ...publishArgs], { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`publish failed: ${pkg.name} (${missing.length - i} left; run again to resume)`);
    process.exit(res.status ?? 1);
  }
}
console.log(`published ${missing.length} package(s)`);
