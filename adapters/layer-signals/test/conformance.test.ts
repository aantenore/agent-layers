import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

test('layer-signals passes EvaluatorPort conformance', async () => {
  const report = await checkAdapter(adapter, {
    fixtures: {
      cases: [
        { case: { id: 'ok', input: 'hi' }, run: { runId: 'r1', output: 'hello', status: 'completed' }, expect: { metric: 'harness_health', value: 1 } },
        { case: { id: 'failed', input: 'hi' }, run: { runId: 'r2', output: '', status: 'stopped', reason: { code: 'limit', layer: 'harness' }, events: [{ type: 'run.end', status: 'stopped', reason: { code: 'limit', layer: 'harness' } }] }, expect: { metric: 'harness_health', value: 0 } },
        { case: { id: 'waiting', input: 'hi' }, run: { runId: 'r4', output: '', status: 'waiting', reason: { code: 'needs_input', layer: 'identity' } }, expect: { metric: 'harness_health', value: 1 } },
        { case: { id: 'attributed', input: 'hi' }, run: { runId: 'r5', output: '', status: 'completed', events: [{ type: 'tool.result', id: '1', tool: 'a', ok: false }] }, expect: { metric: 'attributed', value: 0 } },
        { case: { id: 'tools', input: 'hi' }, run: { runId: 'r3', output: '', status: 'completed', events: [{ type: 'tool.result', id: '1', tool: 'a', ok: false }, { type: 'tool.result', id: '2', tool: 'b', ok: true }] }, expect: { metric: 'tool_health', value: 0.5 } },
      ],
    },
  });
  assert.deepEqual(report.failures, []);
});
