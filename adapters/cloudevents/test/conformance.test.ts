import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAdapter, inboundFetch } from '@agent-layers/conformance';
import type { InboundMount } from '@agent-layers/core';
import { adapter } from '../src/index.ts';

test('cloudevents adapter passes TriggerPort conformance', async () => {
  const report = await checkAdapter(adapter, {
    options: { routes: [{ type: 'com.example.*', agent: 'assistant' }] },
    fixtures: {
      fireMount: async (mount: InboundMount) => {
        const res = await inboundFetch(mount, new Request('http://host/v1/events', {
          method: 'POST',
          headers: { 'content-type': 'application/cloudevents+json' },
          body: JSON.stringify({
            specversion: '1.0', id: 'e-1', source: '/orders', type: 'com.example.order.created',
            time: '2026-01-02T03:04:05Z', data: { total: 12 },
          }),
        }));
        assert.equal(res.status, 202);
      },
    },
  });
  assert.deepEqual(report.failures, []);
});
