import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, defineAdapter, PORT_VERSIONS, resolveProfile, type ChannelPort } from '@agent-layers/core';
import { adapter as basicRuntime } from '@agent-layers/adapters/basic-runtime';
import { adapter as mockModel } from '@agent-layers/adapters/mock-model';
import { serveStack } from '../src/index.ts';

const channel = (name: string, exposeHeaders?: string[]) => defineAdapter<'ChannelPort'>({
  layer: 'interface', port: 'ChannelPort', name, direction: 'inbound', maps: { technology: 'test route' },
  portVersion: PORT_VERSIONS.ChannelPort, tiers: ['prototype'], optionsSchema: { type: 'object' },
  create: (): ChannelPort => ({
    mount: () => ({
      routes: [{ path: `/${name}`, methods: ['GET'], public: true, handle: async () => new Response('ok') }],
      ...(exposeHeaders ? { exposeHeaders } : {}),
    }),
  }),
});

test('CORS exposes the default headers plus those each mount declares', async () => {
  const stack = await compose(resolveProfile({
    agents: { assistant: { instructions: '', model: 'mock' } },
    layers: {
      model: { adapter: 'mock-model' },
      runtime: { adapter: 'basic-runtime' },
      channels: [{ adapter: 'plain' }, { adapter: 'sessions' }],
    },
  }), { adapters: [mockModel, basicRuntime, channel('plain'), channel('sessions', ['X-Session-Token', 'mcp-session-id'])] });
  const gw = await serveStack(stack, { port: 0, anonymous: true, cors: { origins: ['http://app.test'] } });
  try {
    const res = await fetch(`${gw.url}/plain`, { headers: { origin: 'http://app.test' } });
    assert.equal(res.headers.get('access-control-expose-headers'), 'mcp-session-id, x-request-id, x-session-token');
  } finally {
    await gw.close();
    await stack.close();
  }
});
