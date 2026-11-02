import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../../src/memory-store/index.ts';

test('memory-store passes StorePort conformance', async () => {
  const report = await checkAdapter(adapter);
  assert.deepEqual(report.failures, []);
});
