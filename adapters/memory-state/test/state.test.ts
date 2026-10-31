import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunEvent } from '@agent-layers/core';
import { createMemoryState } from '../src/index.ts';

const start = (runId: string): RunEvent => ({ type: 'run.start', runId, agent: 'a' });
const end: RunEvent = { type: 'run.end', status: 'completed' };
const text = (t: string): RunEvent => ({ type: 'text', text: t });

test('read returns appended events in order', async () => {
  const state = createMemoryState();
  await state.append('s', [start('r1'), text('a')]);
  await state.append('s', [end]);
  assert.deepEqual((await state.read('s')).map((e) => e.type), ['run.start', 'text', 'run.end']);
});

test('events are copied on append and on read', async () => {
  const state = createMemoryState();
  const event = { type: 'acme.note', data: { n: 1 } } satisfies RunEvent;
  await state.append('s', [event]);
  event.data.n = 2;
  const [read] = await state.read('s');
  assert.deepEqual(read, { type: 'acme.note', data: { n: 1 } });
  (read as typeof event).data.n = 3;
  assert.deepEqual((await state.read('s'))[0], { type: 'acme.note', data: { n: 1 } });
});

test('list returns the most recently appended sessions first, limited', async () => {
  const state = createMemoryState();
  await state.append('one', [start('1')]);
  await state.append('two', [start('2')]);
  await state.append('three', [start('3')]);
  await state.append('one', [end]);
  assert.deepEqual(await state.list(), ['one', 'three', 'two']);
  assert.deepEqual(await state.list({ limit: 2 }), ['one', 'three']);
});

test('delete forgets a session', async () => {
  const state = createMemoryState();
  await state.append('s', [start('1')]);
  await state.delete('s');
  assert.deepEqual(await state.read('s'), []);
  assert.deepEqual(await state.list(), []);
});
