import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';
import { mockPresidio, type MockPresidio } from './mock-presidio.ts';

let presidio: MockPresidio;
before(async () => { presidio = await mockPresidio(); });
after(() => presidio.close());

const fixtures = {
  redact: [
    { stage: 'input' as const, text: 'Mail me at jane.doe@example.com please', secret: 'jane.doe@example.com' },
    { stage: 'tool_result' as const, text: 'owner: bob@example.org', secret: 'bob@example.org' },
  ],
};

test('presidio passes GuardPort conformance (redact)', async () => {
  const report = await checkAdapter(adapter, { options: { analyzerUrl: presidio.analyzerUrl, anonymizerUrl: presidio.anonymizerUrl }, fixtures });
  assert.deepEqual(report.failures, []);
});

test('presidio passes GuardPort conformance (block)', async () => {
  const report = await checkAdapter(adapter, {
    options: { analyzerUrl: presidio.analyzerUrl, action: 'block' },
    fixtures: { block: [{ stage: 'output', text: 'contact jane.doe@example.com' }] },
  });
  assert.deepEqual(report.failures, []);
});
