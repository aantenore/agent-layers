import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

test('mock-model passes ModelPort conformance', async () => {
  const report = await checkAdapter(adapter, { fixtures: { model: 'mock', toolCall: true } });
  assert.deepEqual(report.failures, []);
});
