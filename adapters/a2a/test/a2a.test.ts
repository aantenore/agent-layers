// A2A through the gateway: agent cards, JSON-RPC 1.0 and 0.3, streaming, tasks; then a remote A2A agent as a runtime.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { compose, resolveProfile, type Stack, type StackConfig } from '@agent-layers/core';
import { checkAdapter, inboundFetch } from '@agent-layers/conformance';
import { serveStack, type GatewayHandle } from '@agent-layers/gateway';
import { adapter as basicRuntime } from '@agent-layers/adapter-basic-runtime';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { credentialAdapter, identityAdapter } from '@agent-layers/adapter-static-identity';
import { channelAdapter, runtimeAdapter } from '../src/index.ts';

let stack: Stack;
let gw: GatewayHandle;
const auth = (token = 'dev-token') => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const endpoint = () => `${gw.url}/a2a/assistant`;
let n = 0;
async function rpc(method: string, params: unknown, headers: Record<string, string> = auth()) {
  const res = await fetch(endpoint(), { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
  return { status: res.status, body: res.status === 200 ? await res.json() as { result?: any; error?: { code: number; message: string } } : undefined };
}
const userMessage = (text: string, v: '1.0' | '0.3' = '1.0') => (v === '1.0'
  ? { messageId: `m-${++n}`, role: 'ROLE_USER', parts: [{ text }] }
  : { kind: 'message', messageId: `m-${++n}`, role: 'user', parts: [{ kind: 'text', text }] });

async function frames(res: Response): Promise<any[]> {
  return (await res.text()).split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)).result);
}

before(async () => {
  const config: StackConfig = {
    agents: { assistant: { instructions: 'Be brief.', model: 'mock' }, private: { instructions: '', model: 'mock' } },
    layers: {
      model: { adapter: 'mock-model', options: { latencyMs: 100, rules: [{ match: 'ping', reply: 'pong' }] } },
      runtime: { adapter: 'basic-runtime' },
      identity: { adapter: 'static-identity', options: { tokens: { 'dev-token': { subject: 'dev-user' }, 'other-token': { subject: 'other-user' } } } },
      channels: [{ adapter: 'a2a', options: { agents: ['assistant'], descriptions: { assistant: 'Answers in one word.' } } }],
    },
  };
  stack = await compose(resolveProfile(config), { adapters: [mockModel, basicRuntime, identityAdapter, channelAdapter] });
  gw = await serveStack(stack, { port: 0 });
});

after(async () => {
  await gw.close();
  await stack.close();
});

test('agent cards are public and describe the JSON-RPC interface of A2A 1.0 and 0.3', async () => {
  const card = await (await fetch(`${gw.url}/.well-known/agent-card.json`)).json() as Record<string, any>;
  assert.equal(card.name, 'assistant');
  assert.equal(card.description, 'Answers in one word.');
  assert.deepEqual(card.supportedInterfaces, [
    { url: endpoint(), protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    { url: endpoint(), protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
  ]);
  assert.equal(card.capabilities.streaming, true);
  assert.deepEqual(card.skills.map((s: { id: string }) => s.id), ['assistant']);
  assert.ok(card.securitySchemes.bearer);
  for (const k of ['version', 'defaultInputModes', 'defaultOutputModes']) assert.ok(card[k], k);
  const own = await fetch(`${gw.url}/a2a/assistant/.well-known/agent-card.json`);
  assert.equal(own.status, 200);
  assert.equal((await fetch(`${gw.url}/a2a/private/.well-known/agent-card.json`)).status, 404, 'agents not served have no card');
});

test('SendMessage (1.0) runs the agent with the caller and returns a completed task with the answer', async () => {
  assert.equal((await fetch(endpoint(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const { body } = await rpc('SendMessage', { message: userMessage('ping') });
  const task = body!.result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(task.status.message.role, 'ROLE_AGENT');
  assert.deepEqual(task.artifacts[0].parts, [{ text: 'pong' }]);
  assert.ok(task.contextId);
});

test('message/send (0.3) answers with the 0.3 shapes', async () => {
  const { body } = await rpc('message/send', { message: userMessage('ping', '0.3') });
  assert.equal(body!.result.kind, 'task');
  assert.equal(body!.result.status.state, 'completed');
  assert.deepEqual(body!.result.artifacts[0].parts, [{ kind: 'text', text: 'pong' }]);
});

test('streaming: task, artifact, final status, in both versions', async () => {
  const send = (method: string, v: '1.0' | '0.3') => fetch(endpoint(), { method: 'POST', headers: auth(), body: JSON.stringify({ jsonrpc: '2.0', id: 'st', method, params: { message: userMessage('ping', v) } }) });
  const res = await send('SendStreamingMessage', '1.0');
  assert.match(res.headers.get('content-type')!, /text\/event-stream/);
  const events = await frames(res);
  assert.deepEqual(events.map((e) => Object.keys(e)[0]), ['task', 'artifactUpdate', 'statusUpdate']);
  assert.equal(events[0].task.status.state, 'TASK_STATE_WORKING');
  assert.deepEqual(events[1].artifactUpdate.artifact.parts, [{ text: 'pong' }]);
  assert.equal(events[2].statusUpdate.status.state, 'TASK_STATE_COMPLETED');
  const legacy = await frames(await send('message/stream', '0.3'));
  assert.deepEqual(legacy.map((e) => e.kind), ['task', 'artifact-update', 'status-update']);
  assert.equal(legacy[2].final, true);
});

test('returnImmediately, GetTask and CancelTask; tasks belong to their caller', async () => {
  const started = await rpc('SendMessage', { message: userMessage('ping'), configuration: { returnImmediately: true } });
  const id = started.body!.result.task.id;
  assert.equal(started.body!.result.task.status.state, 'TASK_STATE_WORKING');
  assert.equal((await rpc('GetTask', { id }, auth('other-token'))).body!.error!.code, -32001, 'another caller cannot read it');
  let state = '';
  for (let i = 0; i < 50 && state !== 'TASK_STATE_COMPLETED'; i++) {
    await new Promise((r) => setTimeout(r, 20));
    state = (await rpc('GetTask', { id })).body!.result.status.state;
  }
  assert.equal(state, 'TASK_STATE_COMPLETED');
  assert.equal((await rpc('CancelTask', { id })).body!.error!.code, -32002);
  const running = await rpc('SendMessage', { message: userMessage('ping'), configuration: { returnImmediately: true } });
  const canceled = await rpc('CancelTask', { id: running.body!.result.task.id });
  assert.equal(canceled.body!.result.status.state, 'TASK_STATE_CANCELED');
});

test('protocol errors: version, method, params, content type, unknown agent', async () => {
  assert.equal((await rpc('SendMessage', { message: userMessage('ping') }, { ...auth(), 'a2a-version': '9.9' })).body!.error!.code, -32009);
  assert.equal((await rpc('ListTasks', {})).body!.error!.code, -32601);
  assert.equal((await rpc('SendMessage', { message: { ...userMessage('ping'), role: 'ROLE_AGENT' } })).body!.error!.code, -32602);
  assert.equal((await fetch(endpoint(), { method: 'POST', headers: { ...auth(), 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${gw.url}/a2a/private`, { method: 'POST', headers: auth(), body: '{}' })).status, 404);
  const foreign = await fetch(endpoint(), { method: 'POST', headers: { ...auth(), origin: 'http://evil.test' }, body: '{}' });
  assert.equal(foreign.status, 403, 'the gateway refuses foreign browser origins');
});

test('a remote A2A agent is the runtime of another stack, with the caller credential forwarded', async () => {
  for (const [version, url] of [['1.0', `${gw.url}/.well-known/agent-card.json`], ['0.3', endpoint()]] as const) {
    const client = await compose(resolveProfile({
      agents: { assistant: { instructions: '', model: 'remote' } },
      layers: {
        runtime: { adapter: 'a2a', options: { url, version, auth: { audience: 'agents' } } },
        credentials: { adapter: 'static-identity', options: { tokens: { agents: 'dev-token' } } },
      },
    }), { adapters: [runtimeAdapter, credentialAdapter] });
    try {
      const r = await (await client.agent('assistant')).run('ping');
      assert.equal(r.status, 'completed', version);
      assert.equal(r.output, 'pong');
    } finally {
      await client.close();
    }
  }
});

test('a refused or unreachable remote agent is a failed run with a fixed reason', async () => {
  const client = await compose(resolveProfile({
    agents: { assistant: { instructions: '', model: 'remote' } },
    layers: {
      runtime: { adapter: 'a2a', options: { url: endpoint(), auth: { audience: 'agents' } } },
      credentials: { adapter: 'static-identity', options: { tokens: { agents: 'wrong-secret-token' } } },
    },
  }), { adapters: [runtimeAdapter, credentialAdapter] });
  try {
    const r = await (await client.agent('assistant')).run('ping');
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'remote agent call failed');
    assert.ok(!JSON.stringify(r).includes('wrong-secret-token'));
  } finally {
    await client.close();
  }
});

test('conformance: the runtime and the mounted channel', async () => {
  const client = await compose(resolveProfile({
    agents: { assistant: { instructions: '', model: 'remote' } },
    layers: { runtime: { adapter: 'a2a', options: { url: endpoint(), auth: { audience: 'agents' } } }, credentials: { adapter: 'static-identity', options: { default: 'dev-token' } } },
  }), { adapters: [runtimeAdapter, credentialAdapter] });
  try {
    const runtime = await checkAdapter(runtimeAdapter, {
      options: { url: endpoint(), auth: { audience: 'agents' } },
      fixtures: { stack: client, agent: { name: 'assistant', instructions: '', model: 'remote', tools: [] }, input: 'ping' },
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

test('anonymous tasks (gateway.anonymous: true) are owned by their id and never readable by an authenticated caller', async () => {
  const open = await serveStack(stack, { port: 0, anonymous: true });
  try {
    const call = async (method: string, params: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
      (await (await fetch(`${open.url}/a2a/assistant`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result?: any; error?: { code: number } };
    const started = await call('SendMessage', { message: userMessage('ping'), configuration: { returnImmediately: true } });
    const id = started.result.task.id;
    assert.ok((await call('GetTask', { id })).result, 'the id is the capability');
    assert.equal((await call('GetTask', { id }, auth())).error!.code, -32001);
  } finally {
    await open.close();
  }
});
