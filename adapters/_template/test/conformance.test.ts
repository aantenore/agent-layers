import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

test('template adapter passes GuardPort conformance', async () => {
  const report = await checkAdapter(adapter, {
    options: { deny: ['forbidden'] },
    fixtures: { block: [{ stage: 'input', text: 'this is forbidden' }] },
  });
  assert.deepEqual(report.failures, []);
});
