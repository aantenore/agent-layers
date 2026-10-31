import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

test('layer-signals passes EvaluatorPort conformance', async () => {
  const report = await checkAdapter(adapter, {
    fixtures: {
      cases: [
        { case: { id: 'ok', input: 'hi' }, run: { runId: 'r1', output: 'hello', status: 'completed' }, expect: { metric: 'harness_health', value: 1 } },
        { case: { id: 'failed', input: 'hi' }, run: { runId: 'r2', output: '', status: 'failed', events: [{ type: 'run_end', status: 'failed', reason: 'max_turns' }] }, expect: { metric: 'harness_health', value: 0 } },
        { case: { id: 'tools', input: 'hi' }, run: { runId: 'r3', output: '', status: 'completed', events: [{ type: 'tool_result', name: 'a', isError: true }, { type: 'tool_result', name: 'b' }] }, expect: { metric: 'tool_health', value: 0.5 } },
      ],
    },
  });
  assert.deepEqual(report.failures, []);
});
