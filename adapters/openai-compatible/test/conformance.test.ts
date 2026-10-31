import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';
import { startMock } from './mock.ts';

test('openai-compatible passes ModelPort conformance', async () => {
  const mock = await startMock();
  try {
    const report = await checkAdapter(adapter, {
      options: { baseUrl: mock.url, apiKey: 'sk-test-secret' },
      fixtures: { model: 'mock', toolCall: true },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await mock.close();
  }
});
