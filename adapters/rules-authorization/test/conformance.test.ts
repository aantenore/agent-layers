import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter, sampleAccess } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

test('rules-authorization passes AuthorizationPort conformance', async () => {
  const report = await checkAdapter(adapter, {
    options: { rules: [{ effect: 'allow', risk: ['read'] }] },
    fixtures: {
      allow: [sampleAccess({ risk: 'read' })],
      deny: [sampleAccess({ risk: 'exec' })],
    },
  });
  assert.deepEqual(report.failures, []);
});
