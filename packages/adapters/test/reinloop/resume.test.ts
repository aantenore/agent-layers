// Resume: reinloop replays the run's own event log and runs the call that waited, then the loop goes on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalPending, type AgentSpec, type ModelReply, type Stack, type ToolPort } from '@agent-layers/core';
import { createReinloopRuntime } from '../../src/reinloop/index.ts';
import { scriptedModel, stack, textReply } from './helpers.ts';

const callReply: ModelReply = {
  model: 'scripted', finish: 'tools', usage: { inputTokens: 3, outputTokens: 2 },
  message: { role: 'assistant', parts: [{ type: 'call', id: 'c1', tool: 'math__save', args: { text: 'note' } }] },
};
const spec: AgentSpec = { name: 'calc', instructions: 'You save notes.', model: 'mock', tools: ['math__*'] };

/** The stack with tools whose first call waits for an approval; every call is recorded. */
function waitingOnce(s: Stack, calls: { tool: string; args: unknown }[]): Stack {
  let waits = true;
  return Object.assign(Object.create(s) as Stack, {
    toolsFor(agent: AgentSpec): ToolPort {
      const tools = s.toolsFor(agent);
      return {
        listTools: (ctx) => tools.listTools(ctx),
        async callTool(tool, args, ctx) {
          calls.push({ tool, args });
          if (waits) { waits = false; throw new ApprovalPending('ap-1', { tool, args }); }
          return tools.callTool(tool, args, ctx);
        },
      };
    },
  });
}

async function setup(replies: ModelReply[]) {
  const model = scriptedModel(replies);
  const { s } = await stack({}, { layers: { model: { adapter: 'test-script' } } }, { adapters: [model.adapter] });
  const calls: { tool: string; args: unknown }[] = [];
  const agent = await createReinloopRuntime().bind(waitingOnce(s, calls), spec);
  return { s, agent, calls, requests: model.requests };
}

test('resume with the decision runs the waiting call from the log; the first answer is not asked again', async () => {
  const { s, agent, calls, requests } = await setup([callReply, textReply('saved it')]);
  const first = await agent.run('save note', { runId: 'r-1' });
  assert.equal(first.status, 'waiting');
  assert.ok(first.checkpoint && Array.isArray((first.checkpoint as { events: unknown[] }).events));
  const done = await agent.resume!(JSON.parse(JSON.stringify(first.checkpoint)), { approval: { id: 'ap-1', approved: true } }, { runId: 'r-1' });
  assert.equal(done.status, 'completed');
  assert.equal(done.output, 'saved it');
  assert.deepEqual(calls, [{ tool: 'math__save', args: { text: 'note' } }, { tool: 'math__save', args: { text: 'note' } }]);
  assert.equal(requests.length, 2);
  assert.deepEqual(done.usage, { inputTokens: 3, outputTokens: 2 }, 'the figures of this run only');
  assert.equal(done.checkpoint, undefined);
  await s.close();
});

test('resume with input: the waiting call runs first, then the input reaches the model', async () => {
  const { s, agent, calls, requests } = await setup([callReply, textReply('you are welcome')]);
  const first = await agent.run('save note', { runId: 'r-2' });
  const done = await agent.resume!(first.checkpoint!, { input: 'thanks' }, { runId: 'r-2' });
  assert.equal(done.status, 'completed');
  assert.equal(calls.length, 2);
  assert.equal(requests.length, 2);
  const roles = requests[1]!.messages.map((m) => m.role);
  assert.deepEqual(roles.slice(-2), ['tool', 'user']);
  assert.equal(done.events?.filter((e) => e.type === 'run.start').length, 1);
  await assert.rejects(agent.resume!({ nope: 1 }, { input: 'x' }), /not a checkpoint/);
  await s.close();
});
