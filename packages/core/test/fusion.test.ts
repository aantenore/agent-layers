import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fusePassages, knowledgeInjector, messageText, type KnowledgePort, type Passage } from '../src/index.ts';
import { ctx, fakeModel } from './helpers.ts';

const p = (id: string, score: number, source: string): Passage => ({ id, text: id, score, source });
// BM25 scores are unbounded; cosine similarities sit in [0, 1]. Sorting raw scores lets BM25 win by scale.
const bm25 = { source: 'docs', passages: [p('d1', 14.2, 'docs'), p('d2', 9.7, 'docs'), p('d3', 3.1, 'docs')] };
const cosine = { source: 'vectors', passages: [p('v1', 0.91, 'vectors'), p('v2', 0.88, 'vectors'), p('v3', 0.4, 'vectors')] };

test('RRF interleaves BM25 and cosine lists by rank, not by scale', () => {
  const fused = fusePassages([bm25, cosine]);
  assert.deepEqual(fused.map((x) => x.id), ['d1', 'v1', 'd2', 'v2', 'd3', 'v3']);
  assert.equal(fused[0]!.score, 1 / 61);
  assert.deepEqual(fused[1]!.ext, { 'sdk.raw_score': 0.91, 'sdk.rank': 1 });
  const raw = fusePassages([bm25, cosine], { method: 'raw' });
  assert.deepEqual(raw.map((x) => x.id), ['d1', 'd2', 'd3', 'v1', 'v2', 'v3'], 'raw: today\'s behaviour, opt-in');
  assert.deepEqual(raw[0]!.ext, { 'sdk.raw_score': 14.2, 'sdk.rank': 1 });
});

test('weights and rrfK change the balance; ties break on rank, source order, id', () => {
  assert.deepEqual(fusePassages([bm25, cosine], { weights: { vectors: 2 } }).slice(0, 3).map((x) => x.id), ['v1', 'v2', 'v3']);
  assert.equal(fusePassages([bm25], { rrfK: 1 })[0]!.score, 1 / 2);
  const a = { source: 'a', passages: [p('x', 1, 'a'), p('y', 1, 'a')] };
  const b = { source: 'b', passages: [p('x', 1, 'b')] };
  assert.deepEqual(fusePassages([b, a]).map((x) => `${x.source}/${x.id}`), ['b/x', 'a/x', 'a/y']);
});

test('duplicates are kept once at their best rank; a single source keeps its order; source is filled', () => {
  const dup = { source: 's', passages: [p('1', 3, 's'), p('2', 9, 's'), p('1', 1, 's')] };
  const out = fusePassages([dup]);
  assert.deepEqual(out.map((x) => [x.id, x.ext?.['sdk.rank']]), [['1', 1], ['2', 2]]);
  assert.equal(fusePassages([{ source: 'named', passages: [{ id: 'n', text: 't' } as Passage] }])[0]!.source, 'named');
});

test('the injector fuses sources before taking the top k', async () => {
  const src = (list: Passage[]): KnowledgePort => ({ search: async () => list });
  const { model, requests } = fakeModel();
  await knowledgeInjector({ docs: src(bm25.passages), vectors: src(cosine.passages) }, { k: 2 })(model)
    .chat({ model: 'm', messages: [{ role: 'user', parts: [{ type: 'text', text: 'q' }] }] }, ctx());
  const block = messageText(requests[0]!.messages[0]);
  assert.match(block, /\[1\] \(docs\) d1\n\[2\] \(vectors\) v1/);
  await knowledgeInjector({ docs: src(bm25.passages), vectors: src(cosine.passages) }, { k: 2, fusion: { method: 'raw' } })(model)
    .chat({ model: 'm', messages: [{ role: 'user', parts: [{ type: 'text', text: 'q' }] }] }, ctx());
  assert.match(messageText(requests[1]!.messages[0]), /\[1\] \(docs\) d1\n\[2\] \(docs\) d2/);
});
