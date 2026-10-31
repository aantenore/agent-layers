import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

test('memory-approval passes ApprovalPort conformance', async () => {
  const report = await checkAdapter(adapter);
  assert.deepEqual(report.failures, []);
});
