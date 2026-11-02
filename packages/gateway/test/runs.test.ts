// The run routes: resume and cancel over HTTP, authenticated, authorized, then the stack's own rules.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, ConfigError, defineAdapter, PORT_VERSIONS, resolveProfile, type AuthorizationPort, type Stack, type ToolPort } from '@agent-layers/core';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as approvalAdapter } from '@agent-layers/adapter-memory-approval';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { adapter as rulesAdapter } from '@agent-layers/adapter-rules-authorization';
import { identityAdapter } from '@agent-layers/adapter-static-identity';
import { serveStack } from '../src/index.ts';

const refunds: string[] = [];
const shop = defineAdapter({
  port: 'ToolPort', layer: 'tool', name: 'shop', direction: 'outbound', maps: { technology: 'test double' },
  portVersion: PORT_VERSIONS.ToolPort, tiers: ['prototype'], optionsSchema: { type: 'object' },
  create: (): ToolPort => ({
    listTools: async () => [{ name: 'refund', description: 'Refund an order', params: { type: 'object', properties: { order: { type: 'string' } } }, risk: 'write' }],
    async callTool(_name, args) { refunds.push(String(args.order)); return { ok: true, text: `refunded ${String(args.order)}` }; },
  }),
});

const tokens = { 'ann-key': { subject: 'ann' }, 'eve-key': { subject: 'eve' }, 'op-key': { subject: 'olga', roles: ['operator'] } };
const rules = [
  { effect: 'allow', actions: ['resume', 'cancel'], when: { authenticated: true } },
  { effect: 'allow', actions: ['decide'], when: { roles: ['operator'] } },
  { effect: 'allow', when: { authenticated: true } },
];

const stackOf = (): Promise<Stack> => compose(resolveProfile({
  agents: { assistant: { instructions: '', model: 'mock', tools: ['shop__*'] } },
  policy: [{ effect: 'ask', tools: ['shop__refund'] }],
  layers: {
    model: { adapter: 'mock-model', options: { rules: [{ match: 'refund (\\w+)', tool: 'refund', args: { order: '{{1}}' } }] } },
    runtime: { adapter: 'basic-runtime' },
    tools: { shop: { adapter: 'shop' } },
    identity: { adapter: 'static-identity', options: { tokens } },
    approval: { adapter: 'memory-approval' },
    authorization: { adapter: 'rules-authorization', options: { rules } },
  },
}), { adapters: [mockModel, basicRuntime, shop, identityAdapter, approvalAdapter, rulesAdapter] });

async function serve(stack: Stack, runs: { enabled?: boolean; path?: string } = { enabled: true }) {
  const gw = await serveStack(stack, { port: 0, runs });
  const post = (path: string, token: string | undefined, body: unknown) => fetch(`${gw.url}${path}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { gw, post };
}

/** A run of ann's that waits for the refund's approval. */
async function waiting(stack: Stack, order: string) {
  const ann = await stack.verify('ann-key');
  const r = await (await stack.agent('assistant')).run(`refund ${order}`, { caller: ann });
  assert.equal(r.status, 'waiting');
  return { runId: r.runId, approval: (r.ext!['sdk.approval'] as { id: string }).id };
}

test('the run routes are off unless enabled, and need an authorization adapter', async () => {
  const stack = await stackOf();
  const { gw, post } = await serve(stack, {});
  try {
    assert.equal((await post('/runs/x/cancel', 'ann-key', {})).status, 404);
  } finally {
    await gw.close();
  }
  const bare = await compose(resolveProfile({ agents: { a: { model: 'm' } }, layers: { identity: { adapter: 'static-identity', options: { tokens } } } }), { adapters: [identityAdapter] });
  await assert.rejects(serveStack(bare, { port: 0, runs: { enabled: true } }), ConfigError);
  await bare.close();
  await stack.close();
});

test('resume: an operator decides and continues ann\'s run; ann may not approve her own refund', async () => {
  const stack = await stackOf();
  const { gw, post } = await serve(stack);
  try {
    const run = await waiting(stack, 'A1');
    const approve = { approval: { id: run.approval, approved: true } };
    assert.equal((await post(`/runs/${run.runId}/resume`, undefined, approve)).status, 401);
    assert.equal((await post(`/runs/${run.runId}/resume`, 'ann-key', { approval: { id: run.approval } })).status, 400);
    assert.equal((await post(`/runs/${run.runId}/resume`, 'ann-key', approve)).status, 403, 'the owner still needs decide');
    assert.equal((await post(`/runs/${run.runId}/resume`, 'eve-key', { input: 'go' })).status, 403, 'another caller');
    assert.equal((await post('/runs/nope/resume', 'ann-key', { input: 'go' })).status, 404);
    const res = await post(`/runs/${run.runId}/resume`, 'op-key', approve);
    assert.equal(res.status, 200);
    const body = await res.json() as { runId: string; status: string; output: string };
    assert.deepEqual([body.runId, body.status, body.output], [run.runId, 'completed', 'refunded A1']);
    assert.deepEqual(refunds, ['A1']);
    assert.equal((await post(`/runs/${run.runId}/resume`, 'op-key', approve)).status, 404, 'once');
  } finally {
    await gw.close();
    await stack.close();
  }
});

test('cancel: the owner withdraws a waiting run and its approval; a later resume is a conflict', async () => {
  const stack = await stackOf();
  const { gw, post } = await serve(stack);
  try {
    const run = await waiting(stack, 'B2');
    assert.equal((await post(`/runs/${run.runId}/cancel`, 'eve-key', {})).status, 403);
    const res = await post(`/runs/${run.runId}/cancel`, 'ann-key', { reason: 'changed my mind' });
    assert.deepEqual(await res.json(), { runId: run.runId, outcome: 'cancelled' });
    assert.equal((await stack.ports.approval!.get(run.approval))!.status, 'cancelled');
    assert.equal((await post(`/runs/${run.runId}/resume`, 'op-key', { approval: { id: run.approval, approved: true } })).status, 409);
    assert.ok(!refunds.includes('B2'));
  } finally {
    await gw.close();
    await stack.close();
  }
});

test('resume and cancel are authorized on the run\'s own agent: a policy for agent a does not open a run of agent b', async () => {
  const onlyA = defineAdapter({
    port: 'AuthorizationPort', layer: 'identity', name: 'only-a', direction: 'outbound', maps: { technology: 'test double' },
    portVersion: PORT_VERSIONS.AuthorizationPort, tiers: ['prototype'], optionsSchema: { type: 'object' },
    create: (): AuthorizationPort => ({
      evaluate: async (q) => ({ allowed: q.action === 'resume' || q.action === 'cancel' ? q.target.kind === 'run' && q.target.agent === 'a' : true }),
    }),
  });
  const stack = await compose(resolveProfile({
    agents: { a: { instructions: '', model: 'mock', tools: ['shop__*'] }, b: { instructions: '', model: 'mock', tools: ['shop__*'] } },
    policy: [{ effect: 'ask', tools: ['shop__refund'] }],
    layers: {
      model: { adapter: 'mock-model', options: { rules: [{ match: 'refund (\\w+)', tool: 'refund', args: { order: '{{1}}' } }] } },
      runtime: { adapter: 'basic-runtime' },
      tools: { shop: { adapter: 'shop' } },
      identity: { adapter: 'static-identity', options: { tokens } },
      approval: { adapter: 'memory-approval' },
      authorization: { adapter: 'only-a' },
    },
  }), { adapters: [mockModel, basicRuntime, shop, identityAdapter, approvalAdapter, onlyA] });
  const { gw, post } = await serve(stack);
  try {
    const ann = await stack.verify('ann-key');
    const start = async (agent: string, order: string) => {
      const r = await (await stack.agent(agent)).run(`refund ${order}`, { caller: ann });
      assert.equal(r.status, 'waiting');
      return { runId: r.runId, approval: (r.ext!['sdk.approval'] as { id: string }).id };
    };
    const ofB = await start('b', 'C3');
    const approveB = { approval: { id: ofB.approval, approved: true } };
    assert.equal((await post(`/runs/${ofB.runId}/resume`, 'ann-key', approveB)).status, 403, 'a run of agent b');
    assert.equal((await post(`/runs/${ofB.runId}/cancel`, 'ann-key', {})).status, 403, 'a run of agent b');
    assert.equal((await post('/runs/nope/resume', 'ann-key', { input: 'go' })).status, 403, 'an unknown run answers like a refused one');
    assert.ok(!refunds.includes('C3'));
    assert.equal((await stack.ports.approval!.get(ofB.approval))!.status, 'pending');

    const ofA = await start('a', 'D4');
    const res = await post(`/runs/${ofA.runId}/resume`, 'ann-key', { approval: { id: ofA.approval, approved: true } });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { status: string }).status, 'completed');
    assert.ok(refunds.includes('D4'));
  } finally {
    await gw.close();
    await stack.close();
  }
});
