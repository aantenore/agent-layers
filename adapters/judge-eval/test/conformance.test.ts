import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

test('judge-eval passes EvaluatorPort conformance with a model adapter as backend', async () => {
  const report = await checkAdapter(adapter, {
    options: { model: 'judge-1', backend: { adapter: 'mock-model', options: { rules: [{ match: 'Criteria', reply: '{"score": 0.75, "reason": "mostly right"}' }] } } },
    fixtures: {
      cases: [
        { case: { id: 'a', input: 'What is 2+2?', expected: '4' }, run: { runId: 'r1', output: 'The answer is 4.', status: 'completed' }, expect: { metric: 'judge', value: 0.75 } },
        { case: { id: 'b', input: 'Say hi', layer: 'llm' }, run: { runId: 'r2', output: '', status: 'failed' } },
      ],
    },
  });
  assert.deepEqual(report.failures, []);
});

test('a backend that is not installed is reported at creation', async () => {
  const report = await checkAdapter(adapter, { options: { model: 'm', backend: { adapter: 'no-such-model' } } });
  assert.ok(report.failures.some((f) => f.includes('no-such-model')), report.failures.join('; '));
});
