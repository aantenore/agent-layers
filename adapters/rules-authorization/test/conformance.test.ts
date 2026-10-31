import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter, sampleQuestion } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

test('rules-authorization passes AuthorizationPort conformance', async () => {
  const report = await checkAdapter(adapter, {
    options: { rules: [{ effect: 'allow', risk: ['read'], when: { kind: 'user' } }] },
    fixtures: {
      allow: [sampleQuestion({ risk: 'read' })],
      deny: [sampleQuestion({ risk: 'exec' })],
    },
  });
  assert.deepEqual(report.failures, []);
});
