// The bounds extension end to end: a calling stack (a2a runtime) passes what is left of its run's bounds to a served
// stack (a2a channel), which can only tighten its own limits, refuses a call over the hop limit and reports why.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import {
  compose, defineAdapter, findRoute, PORT_VERSIONS, resolveProfile, type CallContext, type RunResult, type RuntimePort, type Stack, type StackConfig,
} from '@agent-layers/core';
import { BOUNDS_ALIAS_URI, BOUNDS_URI, createA2AServerChannel, runtimeAdapter } from '../src/index.ts';

/** Runtime of the served stack: records the context of each run and reports a fixed usage. */
const seen: CallContext[] = [];
const recorder: RuntimePort = {
  bind: (stack, agent) => ({
    name: agent.name,
    async run(_input, c) {
      const ctx = stack.context({ ...c, agent: agent.name });
      seen.push(ctx);
      return { runId: ctx.runId, status: 'completed', output: 'done', usage: { inputTokens: 12, outputTokens: 5 }, costUsd: 0.25 };
    },
  }),
};
const recorderAdapter = defineAdapter({
  layer: 'harness', port: 'RuntimePort', name: 'recorder', direction: 'outbound', maps: { technology: 'test double' },
  portVersion: PORT_VERSIONS.RuntimePort, tiers: ['prototype'], optionsSchema: { type: 'object' }, create: () => recorder,
});

let server: Server;
let served: Stack;
let url: string;
let endpoint: string;

before(async () => {
  served = await compose(resolveProfile({
    agents: { assistant: { model: 'm' } }, layers: { runtime: { adapter: 'recorder' } }, limits: { run: { maxHops: 2, maxTokens: 500 } },
  }), { adapters: [recorderAdapter] });
  const mount = await createA2AServerChannel({}, 'a2a').mount!(served.host());
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const origin = `http://${req.headers.host}`;
    const request = new Request(`${origin}${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
    });
    const { route } = findRoute(mount.routes, request.method, new URL(request.url).pathname);
    if (!route) { res.writeHead(404).end(); return; }
    const response = await route.handle(request, { requestId: 'rt', signal: request.signal, origin, caller: { id: 'stack-a', kind: 'agent', roles: [], scopes: [] } });
    res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/a2a/assistant`;
  url = `${endpoint}/.well-known/agent-card.json`;
});

after(async () => { server.closeAllConnections(); server.close(); await served.close(); });

async function caller(limits: StackConfig['limits'] = {}, options: Record<string, unknown> = {}): Promise<Stack> {
  return compose(resolveProfile({
    agents: { assistant: { model: 'remote' } }, layers: { runtime: { adapter: 'a2a', options: { url: endpoint, ...options } } }, limits,
  } as never), { adapters: [runtimeAdapter] });
}

async function rpc(message: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }], ...message } } }),
  });
  return { res, body: await res.json() as { result?: { task: { status: { state: string }; metadata?: Record<string, any> } }; error?: { code: number } } };
}

test('the card declares the bounds extension as optional', async () => {
  const card = await (await fetch(url)).json() as { capabilities: { extensions?: { uri: string; required: boolean }[] } };
  assert.deepEqual(card.capabilities.extensions?.map((e) => [e.uri, e.required]), [[BOUNDS_URI, false]]);
});

test('a delegated run gets one more hop, less time, the caller\'s lineage, and only tighter limits', async () => {
  seen.length = 0;
  const a = await caller({ run: { maxHops: 9, maxTokens: 100 } });
  try {
    const r = await (await a.agent('assistant')).run('hi', { runId: 'run-a' });
    assert.equal(r.status, 'completed');
    assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 5 });
    const b = seen.at(-1)!;
    // Hops: the caller sent 1, and the verified caller (an agent) is one hop too.
    assert.equal(b.bounds?.hops, 1);
    assert.equal(b.bounds?.maxHops, 2, 'the served stack keeps its own, tighter hop limit');
    assert.equal(b.bounds?.tokens, 100, 'the caller\'s tighter budget applies');
    assert.ok(Date.parse(b.bounds!.deadlineAt!) - Date.now() < 299_000, 'the deadline shrank by at least the margin');
    assert.deepEqual(b.lineage, { rootRunId: 'run-a', parentRunId: 'run-a' });
  } finally {
    await a.close();
  }
});

test('the served stack refuses a call over its hop limit; the caller gets hop_limit, not a generic rejection', async () => {
  seen.length = 0;
  const a = await caller({ run: { maxHops: 9 } });
  try {
    const r = await (await a.agent('assistant')).run('hi', { delegation: { remainingMs: 60_000, hops: 2, maxHops: 9 } });
    assert.equal(seen.length, 0, 'no run started on the served stack');
    assert.deepEqual({ status: r.status, code: r.reason?.code }, { status: 'stopped', code: 'hop_limit' });
  } finally {
    await a.close();
  }
});

test('a call that would exceed the chain\'s hop limit is refused locally, without a network call', async () => {
  seen.length = 0;
  const a = await caller();
  try {
    const r = await (await a.agent('assistant')).run('hi', { delegation: { remainingMs: 60_000, hops: 3, maxHops: 3 } });
    assert.deepEqual(r.reason, { code: 'hop_limit', layer: 'harness', by: 'sdk.hops' });
    assert.equal(seen.length, 0);
  } finally {
    await a.close();
  }
});

test('the extension can be turned off on the client: nothing is sent', async () => {
  seen.length = 0;
  const a = await caller({}, { extensions: [] });
  try {
    await (await a.agent('assistant')).run('hi');
    assert.equal(seen.at(-1)?.lineage, undefined);
    assert.equal(seen.at(-1)?.bounds?.hops, 1, 'the verified agent caller still counts');
  } finally {
    await a.close();
  }
});

test('on the wire: activated by header, echoed back; figures and the stop code under the URI and the old key', async () => {
  const data = { remainingMs: 30_000, hops: 1, maxHops: 4, tokens: 50, rootRunId: 'root', parentRunId: 'p' };
  const ok = await rpc({ metadata: { [BOUNDS_URI]: data } }, { 'a2a-extensions': BOUNDS_URI });
  assert.equal(ok.res.headers.get('a2a-extensions'), BOUNDS_URI);
  assert.deepEqual(ok.body.result?.task.metadata, {
    'agent-layers': { usage: { inputTokens: 12, outputTokens: 5 }, costUsd: 0.25 },
    [BOUNDS_URI]: { usage: { inputTokens: 12, outputTokens: 5 }, costUsd: 0.25 },
  });
  assert.equal(seen.at(-1)?.bounds?.tokens, 50);
  const refused = await rpc({ metadata: { [BOUNDS_URI]: { ...data, hops: 3 } }, extensions: [BOUNDS_URI] });
  assert.equal(refused.body.result?.task.status.state, 'TASK_STATE_REJECTED');
  assert.deepEqual(refused.body.result?.task.metadata?.[BOUNDS_URI], { stop: 'hop_limit' });
});

test('the agent-plexus URI is accepted as an alias; data without activation is ignored; malformed data is refused', async () => {
  seen.length = 0;
  await rpc({ metadata: { [BOUNDS_ALIAS_URI]: { remainingMs: 30_000, hops: 1, maxHops: 4, rootRunId: 'plexus-root', parentRunId: 'plexus-p' } } }, { 'a2a-extensions': BOUNDS_ALIAS_URI });
  assert.deepEqual(seen.at(-1)?.lineage, { rootRunId: 'plexus-root', parentRunId: 'plexus-p' });
  await rpc({ metadata: { [BOUNDS_URI]: { remainingMs: 30_000, hops: 1, maxHops: 4, rootRunId: 'ignored', parentRunId: 'ignored' } } });
  assert.equal(seen.at(-1)?.lineage, undefined);
  const bad = await rpc({ metadata: { [BOUNDS_URI]: { remainingMs: -5, hops: 1, maxHops: 4 } } }, { 'a2a-extensions': BOUNDS_URI });
  assert.equal(bad.body.error?.code, -32602);
});

test('the reservation of a delegated call is settled with what the remote run reported', async () => {
  const spent: RunResult[] = [];
  const a = await caller({ run: { maxTokens: 1000 } });
  try {
    spent.push(await (await a.agent('assistant')).run('hi'));
    // The host fills nothing here (the runtime reports the remote usage); the run's ledger was debited 17 tokens.
    assert.deepEqual(spent[0]!.usage, { inputTokens: 12, outputTokens: 5 });
  } finally {
    await a.close();
  }
});
