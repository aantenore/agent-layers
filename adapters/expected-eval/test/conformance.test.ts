import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

test('expected-eval passes EvaluatorPort conformance', async () => {
  const report = await checkAdapter(adapter, {
    fixtures: {
      cases: [
        { case: { id: 'c1', input: 'What is 2+2?', expected: '4' }, run: { runId: 'r1', output: 'The answer is 4.', status: 'completed' }, expect: { metric: 'expected', value: 1 } },
        { case: { id: 'c2', input: 'What is 2+2?', expected: '5' }, run: { runId: 'r2', output: 'The answer is 4.', status: 'completed' }, expect: { metric: 'expected', value: 0 } },
      ],
    },
  });
  assert.deepEqual(report.failures, []);
});
