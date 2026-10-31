import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter, createTerminalChannel } from '../src/index.ts';

test('terminal-channel passes ChannelPort conformance', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  // The descriptor reads process streams; inject test streams the same way a code user would.
  const withStreams = { ...adapter, create: () => createTerminalChannel({}, { input, output }) };
  const report = await checkAdapter(withStreams, {
    fixtures: {
      exercise: async () => { input.write('hello\n'); await new Promise((r) => setTimeout(r, 50)); },
      expectInput: 'hello',
    },
  });
  assert.deepEqual(report.failures, []);
});
