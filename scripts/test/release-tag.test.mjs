// node --test "scripts/test/*.test.mjs"
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tagOf, tagProblem } from '../lib/release-tag.mjs';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd, ...args) {
  const res = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

function commit(cwd, name) {
  writeFileSync(join(cwd, name), name);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-q', '-m', name);
}

/** A scratch repository, removed after `fn`. */
function inRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-layers-tag-'));
  try {
    git(dir, 'init', '-q');
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a version is publishable only when its annotated tag is at HEAD', () => inRepo((dir) => {
  commit(dir, 'a');
  assert.equal(tagOf('1.2.3'), 'v1.2.3');
  assert.match(tagProblem('1.2.3', dir), /tag v1\.2\.3 does not exist/);
  git(dir, 'tag', '-a', 'v1.2.3', '-m', '1.2.3');
  assert.equal(tagProblem('1.2.3', dir), undefined);
  commit(dir, 'b');
  assert.match(tagProblem('1.2.3', dir), /tag v1\.2\.3 is at [0-9a-f]{12}, not at HEAD/);
  git(dir, 'checkout', '-q', 'v1.2.3');
  assert.equal(tagProblem('1.2.3', dir), undefined);
}));

test('a lightweight tag is refused', () => inRepo((dir) => {
  commit(dir, 'a');
  git(dir, 'tag', 'v1.2.3');
  assert.match(tagProblem('1.2.3', dir), /tag v1\.2\.3 is a lightweight tag/);
}));

test('a folder without commits has nothing to publish from', () => inRepo((dir) => {
  assert.match(tagProblem('1.2.3', dir), /no commit at HEAD/);
}));
