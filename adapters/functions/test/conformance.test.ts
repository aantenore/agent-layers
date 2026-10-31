import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';
import { ADD_MODULE, tempModules } from './helpers.ts';

test('functions passes ToolPort conformance', async () => {
  const { dir, cleanup } = await tempModules({ 'tools.mjs': ADD_MODULE });
  try {
    const report = await checkAdapter(adapter, {
      options: { module: './tools.mjs' },
      ctx: { cwd: dir },
      fixtures: {
        calls: [
          { name: 'add', args: { a: 1, b: 2 }, expect: '3', isError: false },
          { name: 'add', args: { a: 'x' }, isError: true },
          { name: 'boom', args: {}, expect: 'kaboom', isError: true },
        ],
      },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await cleanup();
  }
});
