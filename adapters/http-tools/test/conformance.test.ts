import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';
import { startApi } from './mock.ts';

test('http-tools passes ToolPort conformance', async () => {
  const api = await startApi();
  try {
    const report = await checkAdapter(adapter, {
      options: {
        tools: {
          shout: { description: 'Returns the text', method: 'GET', url: `${api.url}/text/{value}`, schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } },
          status: { description: 'Status', method: 'GET', url: `${api.url}/status/{code}` },
        },
      },
      fixtures: {
        calls: [
          { name: 'shout', args: { value: 'hello' }, expect: 'hello', isError: false },
          { name: 'shout', args: {}, isError: true },
          { name: 'status', args: { code: 503 }, expect: 'HTTP 503', isError: true },
        ],
      },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await api.close();
  }
});
