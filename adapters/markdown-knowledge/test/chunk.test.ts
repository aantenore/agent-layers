import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkMarkdown } from '../src/chunk.ts';

test('headings build paths; text before the first heading is the title chunk', () => {
  const chunks = chunkMarkdown('Intro text\n\n# Top\n\nA\n\n## Sub\n\nB\n\n### Deep\n\nC\n\n## Next\n\nD\n', 'file');
  assert.deepEqual(chunks.map((c) => [c.heading, c.slug, c.body]), [
    ['Top', 'top', 'Intro text'],
    ['Top', 'top-2', 'A'],
    ['Top > Sub', 'sub', 'B'],
    ['Top > Sub > Deep', 'deep', 'C'],
    ['Top > Next', 'next', 'D'],
  ]);
  assert.ok(chunks.every((c) => c.title === 'Top'));
});

test('without a heading the file name is the title; headings of level 4+ stay in the body', () => {
  const chunks = chunkMarkdown('plain\n\n#### small\n\nmore', 'readme');
  assert.deepEqual(chunks, [{ heading: 'readme', name: 'readme', slug: 'readme', title: 'readme', body: 'plain\n\n#### small\n\nmore' }]);
});

test('empty sections are skipped and fenced code is not scanned for headings', () => {
  const chunks = chunkMarkdown('# A\n## Empty\n## Code\n\n```sh\n# not a heading\n```\n', 'f');
  assert.deepEqual(chunks.map((c) => c.heading), ['A > Code']);
  assert.match(chunks[0]!.body, /# not a heading/);
});

test('closing hashes and CRLF are handled', () => {
  const chunks = chunkMarkdown('## Tides ##\r\n\r\nLow at noon.\r\n', 'f');
  assert.deepEqual(chunks.map((c) => [c.heading, c.body]), [['Tides', 'Low at noon.']]);
});
