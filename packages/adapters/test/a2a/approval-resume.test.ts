// A call waiting for a person ends the A2A task input-required; the follow-up in the same context gets the decision.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { compose, defineAdapter, PORT_VERSIONS, resolveProfile, type Approval, type Stack, type StackConfig, type ToolPort } from '@agent-layers/core';
import { serveStack, type GatewayHandle } from '@agent-layers/gateway';
import { adapter as basicRuntime } from '@agent-layers/adapters/basic-runtime';
import { adapter as memoryApproval } from '@agent-layers/adapters/memory-approval';
import { adapter as mockModel } from '@agent-layers/adapters/mock-model';
import { identityAdapter } from '@agent-layers/adapters/static-identity';
import { channelAdapter } from '../../src/a2a/index.ts';

const refunds: string[] = [];
const shop: ToolPort = {
  listTools: async () => [{ name: 'refund', description: 'Refund an order', params: { type: 'object', properties: { order: { type: 'string' } } }, risk: 'write' }],
  async callTool(_name, args) {
    refunds.push(String(args.order));
    return { ok: true, text: `refunded ${String(args.order)}` };
  },
};
const shopAdapter = defineAdapter({
  port: 'ToolPort', layer: 'tool', name: 'shop', direction: 'outbound', maps: { technology: 'test double' },
  portVersion: PORT_VERSIONS.ToolPort, tiers: ['prototype'], optionsSchema: { type: 'object' }, create: () => shop,
});

let stack: Stack;
let gw: GatewayHandle;
let n = 0;

async function send(text: string, contextId: string, token = 'dev-token') {
  const res = await fetch(`${gw.url}/a2a/assistant`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'SendMessage', params: { message: { messageId: `m-${n}`, role: 'ROLE_USER', contextId, parts: [{ text }] } } }),
  });
  const task = ((await res.json()) as { result: { task: { status: { state: string }; artifacts?: { parts: { text: string }[] }[] } } }).result.task;
  return { state: task.status.state, text: task.artifacts?.[0]?.parts[0]?.text ?? '' };
}

/** Pending approvals in the store, newest last. */
function pending(): Approval[] {
  const entries = stack.ports.approval!.native!() as Map<string, { approval: Approval }>;
  return [...entries.values()].map((e) => e.approval).filter((a) => a.status === 'pending');
}

before(async () => {
  const config: StackConfig = {
    agents: { assistant: { instructions: '', model: 'mock', tools: ['shop__*'] } },
    policy: [{ effect: 'ask', tools: ['shop__refund'] }],
    layers: {
      model: { adapter: 'mock-model', options: { rules: [{ match: 'refund (\\w+)', tool: 'refund', args: { order: '{{1}}' } }] } },
      runtime: { adapter: 'basic-runtime' },
      tools: { shop: { adapter: 'shop' } },
      approval: { adapter: 'memory-approval' },
      identity: { adapter: 'static-identity', options: { tokens: { 'dev-token': { subject: 'dev-user' }, 'other-token': { subject: 'other-user' } } } },
      channels: [{ adapter: 'a2a', options: { agents: ['assistant'] } }],
    },
  };
  stack = await compose(resolveProfile(config), { adapters: [mockModel, basicRuntime, memoryApproval, identityAdapter, channelAdapter, shopAdapter] });
  gw = await serveStack(stack, { port: 0 });
});

after(async () => {
  await gw.close();
  await stack.close();
});

test('input-required, then the follow-up in the same context runs the approved call once', async () => {
  const first = await send('refund A1', 'ctx-1');
  assert.equal(first.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.deepEqual(refunds, []);
  assert.equal(pending().length, 1);

  const again = await send('refund A1', 'ctx-1');
  assert.equal(again.state, 'TASK_STATE_INPUT_REQUIRED', 'still pending: the same approval, no new one');
  assert.equal(pending().length, 1);

  await stack.ports.approval!.decide(pending()[0]!.id, { approved: true, by: 'reviewer' });
  const resumed = await send('refund A1', 'ctx-1');
  assert.equal(resumed.state, 'TASK_STATE_COMPLETED');
  assert.equal(resumed.text, 'refunded A1');
  assert.deepEqual(refunds, ['A1']);

  const once = await send('refund A1', 'ctx-1');
  assert.equal(once.state, 'TASK_STATE_INPUT_REQUIRED', 'an approval lets one call through');
  assert.deepEqual(refunds, ['A1']);
});

test('the decision belongs to its session, caller and arguments', async () => {
  const before = pending().length;
  await send('refund B2', 'ctx-2');
  const id = pending().at(-1)!.id;
  await stack.ports.approval!.decide(id, { approved: true });
  assert.equal((await send('refund B2', 'ctx-3')).state, 'TASK_STATE_INPUT_REQUIRED', 'another context');
  assert.equal((await send('refund B2', 'ctx-2', 'other-token')).state, 'TASK_STATE_INPUT_REQUIRED', 'another caller, same context id');
  assert.equal((await send('refund C3', 'ctx-2')).state, 'TASK_STATE_INPUT_REQUIRED', 'other arguments');
  assert.equal(pending().length, before + 3);
  assert.deepEqual(refunds.filter((r) => r !== 'A1'), []);
  assert.equal((await send('refund B2', 'ctx-2')).text, 'refunded B2');
});

test('a denial is refused in later runs of the session', async () => {
  await send('refund D4', 'ctx-4');
  await stack.ports.approval!.decide(pending().at(-1)!.id, { approved: false, reason: 'not eligible' });
  const res = await send('refund D4', 'ctx-4');
  assert.equal(res.state, 'TASK_STATE_COMPLETED');
  assert.match(res.text, /Denied: approval denied: not eligible/);
  assert.ok(!refunds.includes('D4'));
});

/** A send that names the task it continues. */
async function follow(taskId: string, text: string, contextId: string, token = 'dev-token') {
  const res = await fetch(`${gw.url}/a2a/assistant`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'SendMessage', params: { message: { messageId: `m-${n}`, role: 'ROLE_USER', contextId, taskId, parts: [{ text }] } } }),
  });
  return (await res.json()) as { result?: { task: { id: string; status: { state: string }; artifacts?: { parts: { text: string }[] }[] } }; error?: { code: number } };
}

/** The id of the task a send created, read back from the server. */
async function sendTask(text: string, contextId: string) {
  const res = await fetch(`${gw.url}/a2a/assistant`, {
    method: 'POST',
    headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'SendMessage', params: { message: { messageId: `m-${n}`, role: 'ROLE_USER', contextId, parts: [{ text }] } } }),
  });
  return ((await res.json()) as { result: { task: { id: string; status: { state: string } } } }).result.task;
}

test('a follow-up that names the input-required task continues the same run once the approval is decided', async () => {
  const task = await sendTask('refund E5', 'ctx-5');
  assert.equal(task.status.state, 'TASK_STATE_INPUT_REQUIRED');
  const still = await follow(task.id, 'go on', 'ctx-5');
  assert.equal(still.result!.task.status.state, 'TASK_STATE_INPUT_REQUIRED', 'the approval is still pending');
  assert.ok(!refunds.includes('E5'));
  assert.equal((await follow(task.id, 'go on', 'ctx-5', 'other-token')).error?.code, -32001, 'another caller\'s task is unknown');
  await stack.ports.approval!.decide(pending().at(-1)!.id, { approved: true, by: 'reviewer' });
  const done = await follow(task.id, 'go on', 'ctx-5');
  assert.equal(done.result!.task.id, task.id, 'the same task');
  assert.equal(done.result!.task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(refunds.filter((r) => r === 'E5').length, 1);
  assert.equal((await follow(task.id, 'again', 'ctx-5')).error?.code, -32602, 'a completed task does not take follow-ups');
});

test('CancelTask on an input-required task cancels the run in the stack and withdraws its approval', async () => {
  const task = await sendTask('refund F6', 'ctx-6');
  const approval = pending().at(-1)!;
  const res = await fetch(`${gw.url}/a2a/assistant`, {
    method: 'POST',
    headers: { authorization: 'Bearer dev-token', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'CancelTask', params: { id: task.id } }),
  });
  const body = (await res.json()) as { result: { status: { state: string } } };
  assert.equal(body.result.status.state, 'TASK_STATE_CANCELED');
  assert.equal((await stack.ports.approval!.get(approval.id))!.status, 'cancelled');
  await assert.rejects(stack.resume(task.id, { input: 'go' }, { caller: await stack.verify('dev-token') }), /cancelled/);
});
