// The release tag check of `publish-unpublished.mjs`: a version is published from the commit its annotated tag
// `v<version>` names, so the `gitHead` npm records and the tag agree. Zero dependencies; needs `git` on the PATH.
import { spawnSync } from 'node:child_process';

/** The tag of a version, as RELEASING.md creates it. */
export const tagOf = (version) => `v${version}`;

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.error) throw new Error(`git ${args[0]} failed: ${res.error.message}`);
  return res;
}

/** The commit `rev` names in the repository at `cwd`, or undefined when it names none. */
function commitOf(rev, cwd) {
  const res = git(cwd, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`);
  return res.status === 0 ? res.stdout.trim() : undefined;
}

/** Why `version` must not be published from `HEAD` of the repository at `cwd`, or undefined when its tag is at `HEAD`. */
export function tagProblem(version, cwd) {
  const tag = tagOf(version);
  const head = commitOf('HEAD', cwd);
  if (!head) return `no commit at HEAD in ${cwd}`;
  const tagged = commitOf(`refs/tags/${tag}`, cwd);
  if (!tagged) return `tag ${tag} does not exist: commit the release, then git tag -a ${tag} -m ${version}`;
  if (git(cwd, 'cat-file', '-t', `refs/tags/${tag}`).stdout.trim() !== 'tag') {
    return `tag ${tag} is a lightweight tag: recreate it annotated (git tag -a -f ${tag} -m ${version} ${tagged.slice(0, 12)})`;
  }
  if (tagged !== head) return `tag ${tag} is at ${tagged.slice(0, 12)}, not at HEAD (${head.slice(0, 12)}): check out ${tag}`;
  return undefined;
}
