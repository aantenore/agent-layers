import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter } from '@agent-layers/conformance';
import { adapter } from '../src/index.ts';
import { startMock } from './mock.ts';

test('openai-compatible passes ModelPort conformance', async () => {
  const mock = await startMock();
  try {
    const report = await checkAdapter(adapter, {
      options: { baseUrl: mock.url, apiKey: 'sk-test-secret' },
      fixtures: { model: 'mock', toolCall: true },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await mock.close();
  }
});

test('the inbound descriptor passes ChannelPort conformance through its mounted routes', async () => {
  const { channelAdapter } = await import('../src/index.ts');
  const { inboundFetch } = await import('@agent-layers/conformance');
  const report = await checkAdapter(channelAdapter, {
    options: { models: { fast: 'mock' } },
    fixtures: {
      expectInput: 'messages',
      async exerciseMount(mount: Parameters<typeof inboundFetch>[0]) {
        const res = await inboundFetch(mount, new Request('http://gateway.test/v1/chat/completions', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'agent:conformance', messages: [{ role: 'user', content: 'hello' }] }),
        }));
        assert.equal(res.status, 200);
      },
    },
  });
  assert.deepEqual(report.failures, []);
});
