import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryState } from '../src/index.ts';

test('read returns appended events in order', async () => {
  const state = createMemoryState();
  await state.append('s', [{ type: 'a' }, { type: 'b' }]);
  await state.append('s', [{ type: 'c' }]);
  assert.deepEqual((await state.read('s')).map((e) => e.type), ['a', 'b', 'c']);
});

test('events are copied on append and on read', async () => {
  const state = createMemoryState();
  const event = { type: 'a', data: { n: 1 } };
  await state.append('s', [event]);
  event.data.n = 2;
  const [read] = await state.read('s');
  assert.deepEqual(read, { type: 'a', data: { n: 1 } });
  (read as typeof event).data.n = 3;
  assert.deepEqual((await state.read('s'))[0], { type: 'a', data: { n: 1 } });
});

test('list returns the most recently appended sessions first, limited', async () => {
  const state = createMemoryState();
  await state.append('one', [{ type: 'x' }]);
  await state.append('two', [{ type: 'x' }]);
  await state.append('three', [{ type: 'x' }]);
  await state.append('one', [{ type: 'y' }]);
  assert.deepEqual(await state.list(), ['one', 'three', 'two']);
  assert.deepEqual(await state.list({ limit: 2 }), ['one', 'three']);
});

test('delete forgets a session', async () => {
  const state = createMemoryState();
  await state.append('s', [{ type: 'a' }]);
  await state.delete('s');
  assert.deepEqual(await state.read('s'), []);
  assert.deepEqual(await state.list(), []);
});
