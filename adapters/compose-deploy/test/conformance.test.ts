import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';
import { listing, tempProject } from './helpers.ts';

test('compose-deploy passes DeployPort conformance (plan only)', async () => {
  const { root, cleanup } = await tempProject();
  try {
    const before = await listing(root);
    const report = await checkAdapter(adapter, { options: { root } });
    assert.deepEqual(report.failures, []);
    assert.deepEqual(await listing(root), before);
  } finally {
    await cleanup();
  }
});
