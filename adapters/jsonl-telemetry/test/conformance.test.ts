import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

test('jsonl-telemetry passes TelemetryPort conformance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-conf-'));
  try {
    const report = await checkAdapter(adapter, { options: { path: 'out/telemetry.jsonl' }, ctx: { cwd: dir } });
    assert.deepEqual(report.failures, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
