import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

test('static-router passes RouterPort conformance', async () => {
  const report = await checkAdapter(adapter, {
    options: { model: 'small' },
    fixtures: { requests: [{ model: 'default', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }] }], expect: ['small'] },
  });
  assert.deepEqual(report.failures, []);
});
