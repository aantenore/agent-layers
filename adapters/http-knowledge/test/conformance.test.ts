import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';
import { startKnowledgeService } from './mock.ts';

test('http-knowledge passes KnowledgePort conformance', async () => {
  const svc = await startKnowledgeService();
  try {
    const report = await checkAdapter(adapter, {
      options: { url: svc.url },
      fixtures: { query: 'tide gate vault quay', expectText: '14:20', filter: { file: 'tide.md' } },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await svc.close();
  }
});
