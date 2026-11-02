import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../../src/sqlite-store/index.ts';

test('sqlite-store passes StorePort conformance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sqlite-store-'));
  try {
    const report = await checkAdapter(adapter, { options: { path: 'conformance.db' }, ctx: { cwd: dir } });
    assert.deepEqual(report.failures, []);
    assert.ok(existsSync(join(dir, 'conformance.db')), 'relative path resolves against the config folder');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
