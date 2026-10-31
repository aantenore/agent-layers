import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EvalRun } from '@agent-layers/core';
import { createExpectedEval, type ExpectedEvalOptions } from '../src/index.ts';

const run = (output: string, status = 'completed'): EvalRun => ({ runId: 'r', output, status });

async function value(expected: unknown, output: string, options: ExpectedEvalOptions = {}) {
  const [score] = await createExpectedEval(options).score({ id: 'c', input: 'q', expected }, run(output));
  return score?.value;
}

test('no expected answer gives no scores', async () => {
  assert.deepEqual(await createExpectedEval().score({ id: 'c', input: 'q' }, run('anything')), []);
});

test('contains is case-insensitive unless configured', async () => {
  assert.equal(await value('PARIS', 'It is Paris.'), 1);
  assert.equal(await value('PARIS', 'It is Paris.', { caseSensitive: true }), 0);
});

test('equals compares the trimmed output', async () => {
  assert.equal(await value('4', ' 4\n', { mode: 'equals' }), 1);
  assert.equal(await value('4', 'It is 4', { mode: 'equals' }), 0);
});

test('regex mode matches patterns and survives invalid ones', async () => {
  assert.equal(await value('^order #\\d+$', 'Order #42', { mode: 'regex' }), 1);
  const [bad] = await createExpectedEval({ mode: 'regex' }).score({ id: 'c', input: 'q', expected: '(' }, run('x'));
  assert.equal(bad?.value, 0);
  assert.match(bad?.reason ?? '', /invalid regex/);
});

test('a list matches on any answer, all requires every answer', async () => {
  assert.equal(await value(['blue', 'green'], 'It is green.'), 1);
  assert.equal(await value(['blue', 'red'], 'It is green.'), 0);
  assert.equal(await value({ all: ['blue', 'green'] }, 'blue and green'), 1);
  assert.equal(await value({ all: ['blue', 'green'] }, 'only blue'), 0);
});

test('runs that did not complete score 0 with the status as reason', async () => {
  const [score] = await createExpectedEval().score({ id: 'c', input: 'q', expected: 'x' }, run('x', 'stopped'));
  assert.deepEqual(score, { metric: 'expected', value: 0, reason: 'run stopped' });
});

test('metric and layer options apply to the score', async () => {
  const [score] = await createExpectedEval({ metric: 'answer', layer: 'knowledge' }).score({ id: 'c', input: 'q', expected: 'x' }, run('x'));
  assert.equal(score?.metric, 'answer');
  assert.equal(score?.layer, 'knowledge');
});
