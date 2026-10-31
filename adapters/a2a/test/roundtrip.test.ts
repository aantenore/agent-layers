// Server -> client round trip over HTTP, without the gateway: every run outcome becomes a task state and comes back
// as the same status and stop code; usage and cost travel in task metadata; guard names never leave the server.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import {
  compose, findRoute, resolveProfile, type Caller, type ChannelHost, type CallContext, type RunResult, type Stack,
} from '@agent-layers/core';
import { checkAdapter, inboundFetch } from '@agent-layers/conformance';
import { channelAdapter, createA2AServerChannel, runtimeAdapter } from '../src/index.ts';

const GUARD = { code: 'guard_block', layer: 'guardrail', by: 'secret-pii-guard', stage: 'input', detail: 'card number in input' } as const;
const SCRIPT: Record<string, RunResult> = {
  completed: { runId: 'r', status: 'completed', output: 'done', usage: { inputTokens: 12, outputTokens: 5 }, costUsd: 0.25 },
  'completed-cost': { runId: 'r', status: 'completed', output: 'cheap', costUsd: 0.5 },
  'completed-plain': { runId: 'r', status: 'completed', output: 'plain' },
  aborted: { runId: 'r', status: 'stopped', output: '', reason: { code: 'aborted' } },
  guard: { runId: 'r', status: 'stopped', output: '', reason: GUARD },
  denied: { runId: 'r', status: 'stopped', output: '', reason: { code: 'denied', layer: 'identity', by: 'opa-policy-7' } },
  input: { runId: 'r', status: 'waiting', output: 'Which account?', reason: { code: 'needs_input', layer: 'identity', by: 'approvals', detail: 'ap-1' } },
  auth: { runId: 'r', status: 'waiting', output: '', reason: { code: 'needs_auth' } },
  failed: { runId: 'r', status: 'failed', output: 'partial', reason: { code: 'error', detail: 'boom: postgres://user:hunter2@db/prod' } },
};

let server: Server;
let url: string;
let hostCalls: { agent: string; ctx?: Partial<CallContext> }[] = [];

const host: ChannelHost = {
  agents: () => ['assistant'],
  async run(agent, input, ctx) {
    hostCalls.push({ agent, ctx });
    const key = typeof input === 'string' ? input : '';
    const res = SCRIPT[key];
    if (!res) throw new Error(`unscripted input "${key}"`);
    return { ...res, runId: ctx?.runId ?? 'r' };
  },
};

const callerOf = (req: IncomingMessage): Caller | undefined => {
  const id = req.headers['x-test-caller'];
  return typeof id === 'string' ? { id, kind: 'user', roles: [], scopes: [] } : undefined;
};

before(async () => {
  const mount = await createA2AServerChannel({}, 'a2a').mount!(host);
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const origin = `http://${req.headers.host}`;
    const request = new Request(`${origin}${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
    });
    const { route } = findRoute(mount.routes, request.method, new URL(request.url).pathname);
    if (!route) { res.writeHead(404).end(); return; }
    const caller = callerOf(req);
    const response = await route.handle(request, { requestId: 'rt', signal: request.signal, origin, ...(caller ? { caller } : {}) });
    res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/a2a/assistant`;
});

after(() => { server.closeAllConnections(); server.close(); });

async function clientFor(options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<Stack> {
  return compose(resolveProfile({
    agents: { assistant: { instructions: '', model: 'remote' } },
    layers: { runtime: { adapter: 'a2a', options: { url, version: '1.0', ...options } } },
    ...extra,
  } as never), { adapters: [runtimeAdapter] });
}

async function run(input: string, options: Record<string, unknown> = {}): Promise<RunResult> {
  const client = await clientFor(options);
  try { return await (await client.agent('assistant')).run(input); } finally { await client.close(); }
}

test('every run outcome comes back as the same status and stop code, in both protocol versions', async () => {
  const expected: [string, RunResult['status'], string | undefined][] = [
    ['completed', 'completed', undefined],
    ['aborted', 'stopped', 'aborted'],
    ['guard', 'stopped', 'rejected'],
    ['denied', 'stopped', 'rejected'],
    ['input', 'waiting', 'needs_input'],
    ['auth', 'waiting', 'needs_auth'],
    ['failed', 'failed', 'error'],
  ];
  for (const version of ['1.0', '0.3']) {
    for (const [input, status, code] of expected) {
      const r = await run(input, { version });
      assert.equal(r.status, status, `${version} ${input}`);
      assert.equal(r.reason?.code, code, `${version} ${input}`);
      if (code) assert.deepEqual(r.reason, { code, layer: 'harness', by: 'assistant' }, `${version} ${input}: only the adapter's own reason`);
    }
  }
});

test('output: the answer of a completed run, what a waiting run asks, nothing from a failed or stopped one', async () => {
  assert.equal((await run('completed')).output, 'done');
  assert.equal((await run('input')).output, 'Which account?');
  assert.equal((await run('failed')).output, '');
  assert.equal((await run('guard')).output, '');
});

test('guard name, stage and detail never leave the server', async () => {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'guard' }] } } }),
  });
  const text = await res.text();
  assert.match(text, /TASK_STATE_REJECTED/);
  for (const leak of ['secret-pii-guard', 'guard_block', 'card number', 'guardrail', 'stage']) assert.ok(!text.includes(leak), leak);
  const failed = await (await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'SendMessage', params: { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'failed' }] } } }),
  })).text();
  assert.ok(!failed.includes('hunter2'), 'error detail stays inside');
});

test('usage and cost travel in task metadata["agent-layers"] in the language names', async () => {
  const wire = await (await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'completed' }] } } }),
  })).json() as { result: { task: { metadata: unknown } } };
  assert.deepEqual(wire.result.task.metadata, { 'agent-layers': { usage: { inputTokens: 12, outputTokens: 5 }, costUsd: 0.25 } });
  const r = await run('completed');
  assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 5 });
  assert.equal(r.costUsd, 0.25);
  const cost = await run('completed-cost');
  assert.equal(cost.usage, undefined, 'absent parts are omitted');
  assert.equal(cost.costUsd, 0.5);
  const plain = await run('completed-plain');
  assert.equal(plain.usage, undefined);
  assert.equal(plain.costUsd, undefined);
  const noMetadata = await (await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'SendMessage', params: { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'completed-plain' }] } } }),
  })).json() as { result: { task: Record<string, unknown> } };
  assert.ok(!('metadata' in noMetadata.result.task));
});

test('the server owns tasks by caller id and passes the caller and the trace headers unchanged', async () => {
  hostCalls = [];
  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const send = (headers: Record<string, string>) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'completed-plain' }] } } }),
  });
  await send({ 'x-test-caller': 'alice', traceparent, tracestate: 'vendor=1' });
  await send({ traceparent: `00-${'a'.repeat(200)}` });
  assert.equal(hostCalls[0]!.ctx?.caller?.id, 'alice');
  assert.deepEqual(hostCalls[0]!.ctx?.trace, { parent: traceparent, state: 'vendor=1' });
  assert.equal(hostCalls[1]!.ctx?.caller, undefined);
  assert.equal(hostCalls[1]!.ctx?.trace, undefined, 'an over-long traceparent is dropped');
});

test('a state the adapter does not know is a failed run with the native state in ext["a2a.state"]', async () => {
  const remote = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      jsonrpc: '2.0', id: 1, result: { task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_PAUSED_BY_VENDOR' }, metadata: { region: 'eu' } } },
    }));
  });
  await new Promise<void>((r) => remote.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/`;
  const client = await compose(resolveProfile({
    agents: { assistant: { instructions: '', model: 'remote' } },
    layers: { runtime: { adapter: 'a2a', options: { url: base } } },
    mappings: { runtime: { in: [{ from: '/metadata/region', to: '/ext/a2a.region' }] } },
  } as never), { adapters: [runtimeAdapter] });
  try {
    const r = await (await client.agent('assistant')).run('hi');
    assert.equal(r.status, 'failed');
    assert.equal(r.reason?.code, 'error');
    assert.equal(r.ext?.['a2a.state'], 'TASK_STATE_PAUSED_BY_VENDOR');
    assert.equal(r.ext?.['a2a.region'], 'eu', 'ctx.mappings.in sees the remote task');
  } finally {
    await client.close();
    remote.close();
  }
});

test('the channel and the runtime descriptors declare what they write', () => {
  assert.deepEqual(runtimeAdapter.ext?.produces, ['a2a.state']);
  assert.equal(runtimeAdapter.mappingDefaults?.in?.shape, 'RunResult');
  assert.equal(channelAdapter.mappingDefaults, undefined);
});

test('conformance: the runtime against this server, and the mounted channel', async () => {
  const client = await clientFor();
  try {
    const runtime = await checkAdapter(runtimeAdapter, {
      options: { url },
      fixtures: { stack: client, agent: { name: 'assistant', instructions: '', model: 'remote', tools: [] }, input: 'completed' },
    });
    assert.deepEqual(runtime.failures, []);
  } finally {
    await client.close();
  }
  const channel = await checkAdapter(channelAdapter, {
    fixtures: {
      expectInput: 'hello',
      async exerciseMount(mount: Parameters<typeof inboundFetch>[0]) {
        const res = await inboundFetch(mount, new Request('http://gateway.test/a2a/conformance', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'hello' }] } } }),
        }));
        assert.equal(((await res.json()) as { result: { task: { status: { state: string } } } }).result.task.status.state, 'TASK_STATE_COMPLETED');
      },
    },
  });
  assert.deepEqual(channel.failures, []);
});
