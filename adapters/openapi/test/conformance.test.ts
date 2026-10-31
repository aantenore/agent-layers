import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';
import { startApi } from './mock.ts';
import { sampleSpec } from './spec.ts';

test('openapi passes ToolPort conformance', async () => {
  const api = await startApi();
  try {
    const report = await checkAdapter(adapter, {
      options: { spec: sampleSpec(api.url) },
      fixtures: {
        calls: [
          { name: 'get_text_value', args: { value: 'hello' }, expect: 'hello', ok: true },
          { name: 'getStatus', args: { code: 500 }, expect: 'HTTP 500', ok: false },
          { name: 'echoQuery', args: {}, ok: false },
        ],
      },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await api.close();
  }
});
