import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';
import { shim, type Shim } from './shim.ts';

let service: Shim;
before(async () => { service = await shim(); });
after(() => service.close());

test('http-guard passes GuardPort conformance', async () => {
  const report = await checkAdapter(adapter, {
    options: { url: service.url },
    fixtures: {
      block: [{ stage: 'input', text: 'this is Forbidden' }],
      redact: [{ stage: 'tool_result', text: 'the value is secret-123', secret: 'secret-123' }],
    },
  });
  assert.deepEqual(report.failures, []);
});
