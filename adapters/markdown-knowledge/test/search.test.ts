import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMarkdownKnowledge } from '../src/index.ts';
import { FILES, tempDir } from './helpers.ts';

async function withKb<T>(fn: (kb: ReturnType<typeof createMarkdownKnowledge>, dir: string) => Promise<T>, options = {}, files = FILES): Promise<T> {
  const { dir, cleanup } = await tempDir(files);
  try {
    return await fn(createMarkdownKnowledge({ dir: '.', ...options }, { cwd: dir }), dir);
  } finally {
    await cleanup();
  }
}

test('the matching chunk ranks first, with id, source and metadata', () => withKb(async (kb) => {
  const [top, ...rest] = await kb.search({ query: 'Quillmere tide gate at low tide', k: 3 });
  assert.equal(top!.id, 'ports.md#tide-gate');
  assert.equal(top!.source, 'ports.md');
  assert.match(top!.text, /^Port of Quillmere > Tide gate\n\n/);
  assert.match(top!.text, /14:20/);
  assert.deepEqual(top!.metadata, { file: 'ports.md', heading: 'Port of Quillmere > Tide gate', title: 'Port of Quillmere' });
  assert.ok(top!.score! > 0);
  for (const p of rest) assert.ok(p.score! <= top!.score!);
}));

test('a heading match outranks a single mention in a body', () => withKb(async (kb) => {
  const hits = await kb.search({ query: 'lighthouse' });
  assert.equal(hits[0]!.id, 'ports.md#lighthouse');
  assert.ok(hits.some((h) => h.id === 'guild/fishers.md#harbour-dues'));
}));

test('k is respected; options.k is the default of 4', () => withKb(async (kb) => {
  assert.equal((await kb.search({ query: 'quillmere', k: 2 })).length, 2);
  assert.equal((await kb.search({ query: 'quillmere' })).length, 4);
  assert.equal((await kb.search({ query: 'quillmere', k: 50 })).length, 10);
}));

test('options.k changes the default', () => withKb(async (kb) => {
  assert.equal((await kb.search({ query: 'quillmere' })).length, 2);
}, { k: 2 }));

test('filter narrows by glob, string or array', () => withKb(async (kb) => {
  const only = await kb.search({ query: 'quillmere', k: 10, filter: { source: 'guild/*' } });
  assert.deepEqual(only.map((p) => p.source), ['guild/fishers.md', 'guild/fishers.md']);
  const two = await kb.search({ query: 'quillmere', k: 10, filter: { source: ['ports.md', 'history/*'] } });
  assert.deepEqual([...new Set(two.map((p) => p.source))].sort(), ['history/old/founding.md', 'ports.md']);
  assert.deepEqual(await kb.search({ query: 'quillmere', filter: { source: 'nothing.md' } }), []);
}));

test('nested directories are read and ids use POSIX paths', () => withKb(async (kb) => {
  const [top] = await kb.search({ query: 'sisters Anwen Tarsa founded' });
  assert.equal(top!.id, 'history/old/founding.md#founding-of-quillmere');
  assert.equal(top!.source, 'history/old/founding.md');
}));

test('empty, stopword-only and unmatched queries give no passages', () => withKb(async (kb) => {
  assert.deepEqual(await kb.search({ query: '' }), []);
  assert.deepEqual(await kb.search({ query: '   ' }), []);
  assert.deepEqual(await kb.search({ query: 'the of and' }), []);
  assert.deepEqual(await kb.search({ query: 'zyzzyva' }), []);
}));

test('extensions option selects the files', () => withKb(async (kb) => {
  const hits = await kb.search({ query: 'quillmere', k: 10 });
  assert.deepEqual([...new Set(hits.map((h) => h.source))], ['notes.txt']);
}, { extensions: ['txt'] }));

test('dot-directories are skipped', () => withKb(async (kb) => {
  const hits = await kb.search({ query: 'secretword' });
  assert.deepEqual(hits.map((h) => h.source), ['visible.md']);
}, {}, { 'visible.md': '# V\n\nsecretword', '.hidden/h.md': '# H\n\nsecretword' }));

test('refresh reloads the files; without it the cache is kept', () => withKb(async (kb, dir) => {
  assert.deepEqual(await kb.search({ query: 'zyzzyva' }), []);
  await mkdir(join(dir, 'new'), { recursive: true });
  await writeFile(join(dir, 'new', 'a.md'), '# Zyzzyva\n\nA genus of weevils.');
  assert.deepEqual(await kb.search({ query: 'zyzzyva' }), []);
  await kb.refresh();
  assert.equal((await kb.search({ query: 'zyzzyva' }))[0]!.id, 'new/a.md#zyzzyva');
}));

test('a missing directory rejects with a clear message', async () => {
  const kb = createMarkdownKnowledge({ dir: 'does-not-exist' }, { cwd: '/nonexistent-agent-layers' });
  await assert.rejects(kb.search({ query: 'x' }), /directory not found/);
});

test('an aborted signal rejects', () => withKb(async (kb) => {
  await assert.rejects(kb.search({ query: 'quillmere', signal: AbortSignal.abort() }));
}));

test('unicode words are tokenized', () => withKb(async (kb) => {
  const [top] = await kb.search({ query: 'CAFÉ crème' });
  assert.equal(top!.source, 'menu.md');
}, {}, { 'menu.md': '# Menu\n\nUn café et une crème brûlée.', 'other.md': '# Other\n\nNothing here.' }));
