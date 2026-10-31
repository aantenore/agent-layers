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

test('inside a stack the judge uses the governed stack model; backend is only the fallback', async () => {
  const { compose, recordingTelemetry, resolveProfile } = await import('@agent-layers/core');
  const { adapter: mockModel } = await import('@agent-layers/adapter-mock-model');
  const records: { name: string; layer: string }[] = [];
  const stack = await compose(resolveProfile({
    layers: {
      model: { adapter: 'mock-model', options: { rules: [{ match: 'Criteria', reply: '{"score": 1, "reason": "stack model"}' }] } },
      eval: [{ adapter: 'judge-eval', options: { model: 'judge-1', backend: { adapter: 'mock-model', options: { rules: [{ match: 'Criteria', reply: '{"score": 0, "reason": "backend"}' }] } } } }],
    },
  }), { adapters: [mockModel, adapter], telemetry: [recordingTelemetry((r) => records.push(r))] });
  try {
    const [score] = await stack.ports.eval[0]!.score({ id: 'a', input: 'q' }, { runId: 'r', output: 'a', status: 'completed' });
    assert.equal(score!.reason, 'stack model');
    assert.ok(records.some((r) => r.name === 'chat' && r.layer === 'llm'), 'the judge call is a governed llm span');
  } finally {
    await stack.close();
  }
});

test('without a stack or a backend the adapter refuses to start', async () => {
  const report = await checkAdapter(adapter, { options: { model: 'm' } });
  assert.ok(report.failures.some((f) => f.includes('backend is required')), report.failures.join('; '));
});
