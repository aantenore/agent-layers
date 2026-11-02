import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../../src/memory-cache/index.ts';

test('memory-cache passes CachePort conformance', async () => {
  const report = await checkAdapter(adapter);
  assert.deepEqual(report.failures, []);
});
