// Resume: the run continues from its checkpoint, runs exactly the call that waited, then goes on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalPending, type CallContext, type JsonValue, type ModelRequest } from '@agent-layers/core';
import { createBasicRuntime } from '../../src/basic-runtime/index.ts';
import { fakeStack, reply, spec } from './helpers.ts';

/** A model that asks for two calls in one answer, then answers with what it got. */
function scripted() {
  const requests: ModelRequest[] = [];
  const model = {
    async chat(req: ModelRequest) {
      requests.push(structuredClone(req));
      if (requests.length === 1) {
        return { model: 'm', finish: 'tools', message: { role: 'assistant', parts: [
          { type: 'call', id: 'c1', tool: 'pay', args: { amount: 5 } },
          { type: 'call', id: 'c2', tool: 'note', args: { text: 'paid' } },
        ] } };
      }
      const last = req.messages.at(-1)!;
      return reply(`after ${last.role}: ${last.parts.map((p) => ('text' in p ? p.text : '')).join('|')}`);
    },
  };
  return { model, requests };
}

/** Tools where `pay` waits for an approval until `approved` is set. */
function tools(state: { approved: boolean; calls: { tool: string; args: unknown }[] }) {
  return {
    listTools: async () => [],
    async callTool(tool: string, args: Record<string, unknown>, _ctx: CallContext) {
      state.calls.push({ tool, args });
      if (tool === 'pay' && !state.approved) throw new ApprovalPending('ap-1', { tool, args });
      return { ok: true, text: `${tool} ok` };
    },
  };
}

test('a waiting run carries a checkpoint; resume runs the waiting call and those after it, then asks the model again', async () => {
  const { model, requests } = scripted();
  const state = { approved: false, calls: [] as { tool: string; args: unknown }[] };
  const agent = await createBasicRuntime().bind(fakeStack({ model, tools: tools(state) }), { ...spec, tools: ['*'] });
  const first = await agent.run('pay 5');
  assert.equal(first.status, 'waiting');
  assert.equal(first.reason?.code, 'needs_input');
  assert.ok(first.checkpoint, 'a checkpoint');
  assert.equal(JSON.stringify(first.events).includes('checkpoint'), false, 'not in the recorded events');
  assert.deepEqual(state.calls.map((c) => c.tool), ['pay'], 'the calls after the waiting one have not run');

  state.approved = true;
  const done = await agent.resume!(JSON.parse(JSON.stringify(first.checkpoint)) as JsonValue, { approval: { id: 'ap-1', approved: true } }, { runId: first.runId });
  assert.equal(done.status, 'completed');
  assert.deepEqual(state.calls, [{ tool: 'pay', args: { amount: 5 } }, { tool: 'pay', args: { amount: 5 } }, { tool: 'note', args: { text: 'paid' } }]);
  assert.equal(requests.length, 2, 'the first answer is not asked again');
  const sent = requests[1]!.messages;
  assert.deepEqual(sent.slice(-2).map((m) => m.role), ['tool', 'tool']);
  assert.equal(done.checkpoint, undefined);
  assert.equal((done.events?.find((e) => e.type === 'model.reply') as { turn: number }).turn, 2, 'turns go on from the checkpoint');
});

test('an input answer is added after the results of the calls that waited', async () => {
  const { model, requests } = scripted();
  const state = { approved: false, calls: [] as { tool: string; args: unknown }[] };
  const agent = await createBasicRuntime().bind(fakeStack({ model, tools: tools(state) }), { ...spec, tools: ['*'] });
  const first = await agent.run('pay 5');
  state.approved = true;
  const done = await agent.resume!(first.checkpoint!, { input: 'and thanks' }, { runId: first.runId });
  assert.equal(done.output, 'after user: and thanks');
  assert.deepEqual(requests[1]!.messages.slice(-3).map((m) => m.role), ['tool', 'tool', 'user']);
});

test('a call that still waits ends the resumed run waiting again, with a new checkpoint', async () => {
  const { model } = scripted();
  const state = { approved: false, calls: [] as { tool: string; args: unknown }[] };
  const agent = await createBasicRuntime().bind(fakeStack({ model, tools: tools(state) }), { ...spec, tools: ['*'] });
  const first = await agent.run('pay 5');
  const again = await agent.resume!(first.checkpoint!, { approval: { id: 'ap-1', approved: true } }, { runId: first.runId });
  assert.equal(again.status, 'waiting');
  assert.deepEqual(again.checkpoint, first.checkpoint);
  await assert.rejects(agent.resume!({ nope: true }, { input: 'x' }), /not a checkpoint/);
});
