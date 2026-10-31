import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';
import { tempDir } from './helpers.ts';

test('markdown-knowledge passes KnowledgePort conformance', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const report = await checkAdapter(adapter, {
      options: { dir: '.' },
      ctx: { cwd: dir },
      fixtures: { query: 'quillmere tide gate', expectText: '14:20', filter: { source: 'guild/fishers.md' } },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await cleanup();
  }
});
