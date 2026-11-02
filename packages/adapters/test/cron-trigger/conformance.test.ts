import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../../src/cron-trigger/index.ts';

test('cron-trigger adapter passes TriggerPort conformance', async () => {
  const report = await checkAdapter(adapter, {
    options: { schedules: [{ name: 'tick', everyMs: 1000, agent: 'assistant', input: 'tick' }] },
    // The schedule fires by itself; conformance waits after this fixture and checks what was delivered.
    fixtures: { fire: async () => { await new Promise((r) => setTimeout(r, 1000)); } },
  });
  assert.deepEqual(report.failures, []);
});
