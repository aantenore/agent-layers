import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { knowledgeAdapter, toolAdapter } from '../src/index.ts';
import { startMcpMock } from './mock.ts';

test('mcp passes ToolPort conformance', async () => {
  const mock = await startMcpMock();
  try {
    const report = await checkAdapter(toolAdapter, {
      options: { url: mock.url },
      fixtures: {
        calls: [
          { name: 'echo', args: { text: 'hi' }, expect: 'echo: hi', isError: false },
          { name: 'fail', args: {}, expect: 'it broke', isError: true },
        ],
      },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await mock.close();
  }
});

test('mcp passes KnowledgePort conformance', async () => {
  const mock = await startMcpMock({ sse: true });
  try {
    const report = await checkAdapter(knowledgeAdapter, {
      options: { url: mock.url, tool: 'search' },
      fixtures: { query: 'tide gate closes vault', expectText: '14:20', filter: { file: 'tide.md' } },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await mock.close();
  }
});
