import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalPending, defineAdapter, type ChannelPort, type RunEvent, type RuntimePort, type Stack, type ToolPort } from '@agent-layers/core';
import { CONFORMANCE_APPROVAL, checkAdapter, conformance, conformanceInput, inboundFetch } from '../src/index.ts';

/** A stack whose model answers "ok" and whose one tool is called by the input "use the tool". */
const stack = (): Stack => {
  const tools: ToolPort = { listTools: async () => [{ name: 't__x', description: 'x', params: { type: 'object' } }], callTool: async () => ({ ok: true, text: 'done' }) };
  return { modelFor: () => ({ chat: async () => ({ model: 'm', message: { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] }, finish: 'end' }) }), toolsFor: () => tools } as unknown as Stack;
};

/** A runtime of one model call, or one tool call for "use the tool"; `flaws` breaks one behaviour. */
const runtime = (flaws: { ignoreAbort?: boolean; swallowApproval?: boolean; streamStatus?: 'failed' } = {}): RuntimePort => ({
  bind: (s, agent) => {
    const run = async (input: unknown, c: { signal?: AbortSignal; runId?: string } = {}) => {
      if (c.signal?.aborted && !flaws.ignoreAbort) return { runId: 'r', status: 'stopped' as const, output: '', reason: { code: 'aborted' } };
      if (input === 'use the tool') {
        try {
          await s.toolsFor(agent).callTool('t__x', {}, { runId: 'r', agent: agent.name, ...c });
        } catch (err) {
          if (!(err instanceof ApprovalPending) || flaws.swallowApproval) return { runId: 'r', status: 'completed' as const, output: 'never mind' };
          return { runId: 'r', status: 'waiting' as const, output: '', reason: err.stopReason };
        }
      }
      const reply = await s.modelFor(agent).chat({ model: 'm', messages: [] }, { runId: 'r', agent: agent.name, ...c });
      return { runId: 'r', status: 'completed' as const, output: (reply.message.parts[0] as { text: string }).text };
    };
    return {
      name: agent.name,
      run,
      async *stream(input: unknown, c?: { signal?: AbortSignal }): AsyncGenerator<RunEvent> {
        const r = await run(input, c);
        if (r.output) yield { type: 'text', text: r.output };
        yield { type: 'run.end', status: flaws.streamStatus ?? r.status, ...('reason' in r && r.reason ? { reason: r.reason } : {}) } as RunEvent;
      },
    };
  },
});

const fixtures = () => ({ stack: stack(), agent: { name: 'a', instructions: '', model: 'm', tools: ['*'] }, toolInput: 'use the tool' });

test('runtime: abort, stream ≡ run, caller and approval checks pass for a sound runtime', async () => {
  const r = await conformance('RuntimePort', runtime(), fixtures());
  assert.deepEqual(r.failures, []);
  assert.ok(!r.skipped.some((s) => s.startsWith('approval') || s.startsWith('caller') || s.startsWith('stream')));
});

test('runtime: each broken behaviour is caught', async () => {
  const failures = async (flaws: Parameters<typeof runtime>[0]) => (await conformance('RuntimePort', runtime(flaws), fixtures())).failures;
  assert.ok((await failures({ ignoreAbort: true })).some((f) => f.startsWith('run aborted')));
  assert.ok((await failures({ swallowApproval: true })).some((f) => f.startsWith('approval')));
  assert.ok((await failures({ streamStatus: 'failed' })).some((f) => f.startsWith('stream: ended failed')));
  const lost: RuntimePort = { bind: (s, agent) => ({ name: agent.name, run: async () => { await s.modelFor(agent).chat({ model: 'm', messages: [] }, { runId: 'r', agent: agent.name }); return { runId: 'r', status: 'completed', output: 'ok' }; } }) };
  assert.ok((await conformance('RuntimePort', lost, fixtures())).failures.some((f) => f.startsWith('caller')));
});

test('runtime: the behaviour checks apply from RuntimePort 1.1.0; a 1.0.0 runtime keeps the earlier checks', async () => {
  const flawed = (portVersion: string) => defineAdapter({
    port: 'RuntimePort', layer: 'harness', name: 'legacy', direction: 'outbound', maps: { technology: 'x' }, portVersion, tiers: ['prototype'],
    optionsSchema: { type: 'object' }, create: () => runtime({ ignoreAbort: true, swallowApproval: true }),
  });
  const v10 = await checkAdapter(flawed('1.0.0'), { fixtures: fixtures() });
  assert.deepEqual(v10.failures, []);
  assert.ok(v10.skipped.some((s) => s.startsWith('behaviour: RuntimePort 1.0.0')));
  const v11 = await checkAdapter(flawed('1.1.0'), { fixtures: fixtures() });
  assert.ok(v11.failures.some((f) => f.startsWith('run aborted')));
  assert.ok(v11.failures.some((f) => f.startsWith('approval')));
  assert.ok((await conformance('RuntimePort', runtime({ ignoreAbort: true }), { ...fixtures(), portVersion: '1.0.0' })).ok, 'the fixture also sets it');
});

/** A JSON channel at /chat: `{text, session?}` in, `{state}` out, where state is the run status or `waiting:<approval>`. */
const channel = (flaws: { dropCaller?: boolean; dropSession?: boolean; hideWaiting?: boolean } = {}): ChannelPort => ({
  mount: (host) => ({
    routes: [{
      path: '/chat', methods: ['POST'],
      async handle(req, ctx) {
        const { text, session } = await req.json() as { text: string; session?: string };
        const r = await host.run('conformance', text, {
          ...(ctx.caller && !flaws.dropCaller ? { caller: ctx.caller } : {}), ...(session && !flaws.dropSession ? { sessionId: `chat-${session}` } : {}),
        });
        const approval = (r.ext?.['sdk.approval'] as { id?: string } | undefined)?.id;
        return Response.json({ state: r.status === 'waiting' && !flaws.hideWaiting ? `waiting:${approval}` : r.status === 'waiting' ? 'completed' : r.status });
      },
    }],
  }),
});

const channelFixtures = {
  sessions: true,
  expectStates: { completed: 'completed', waiting: `waiting:${CONFORMANCE_APPROVAL}`, stopped: 'stopped' },
  async sendMount(mount: Parameters<typeof inboundFetch>[0], text: string, opts: { session?: string }) {
    const res = await inboundFetch(mount, new Request('http://gw.test/chat', { method: 'POST', body: JSON.stringify({ text, ...opts }) }));
    return (await res.json() as { state: string }).state;
  },
};

test('channel: caller, status mapping and session checks', async () => {
  assert.equal(conformanceInput('waiting'), 'conformance:waiting');
  assert.deepEqual((await conformance('ChannelPort', channel(), channelFixtures)).failures, []);
  const failures = async (flaws: Parameters<typeof channel>[0]) => (await conformance('ChannelPort', channel(flaws), channelFixtures)).failures;
  assert.ok((await failures({ dropCaller: true })).some((f) => f.includes('caller did not reach the host')));
  assert.ok((await failures({ dropSession: true })).some((f) => f.startsWith('session:')));
  assert.ok((await failures({ hideWaiting: true })).some((f) => f.startsWith('status waiting')));
});
