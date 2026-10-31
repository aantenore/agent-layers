import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';

test('console-telemetry passes TelemetryPort conformance', async () => {
  // stream stdout would mix into the test report, so the check runs with all output switched off
  const report = await checkAdapter(adapter, { options: { spans: false, events: false } });
  assert.deepEqual(report.failures, []);
});
