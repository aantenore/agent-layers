import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

const user = (content: string) => ({ model: 'default', messages: [{ role: 'user' as const, content }] });

test('rule-router passes RouterPort conformance', async () => {
  const report = await checkAdapter(adapter, {
    options: { rules: [{ when: { maxEstTokens: 20 }, model: 'small' }], default: 'large' },
    fixtures: { requests: [user('hello'), user('x'.repeat(400))], expect: ['small', 'large'] },
  });
  assert.deepEqual(report.failures, []);
});
