import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AdapterRegistry, ANONYMOUS, ApprovalPending, compose, governedTools, inboundSessionId, ownerDigest, readiness, resolveProfile, runEndOf, stopReasonOf,
  type ApprovalPort, type CallContext, type SecretPort, type RunEvent, type RunResult, type RuntimePort, type Stack,
} from '../src/index.ts';
import { ctx, fakeTools, testAdapter } from './helpers.ts';

/** Approval store that never decides: every request is a new pending approval. */
function pendingApproval(): ApprovalPort {
  let n = 0;
  return {
    name: 'approvals',
    request: async (req) => ({ id: `ap-${++n}`, status: 'pending', request: req }),
    get: async () => undefined,
    decide: async () => { throw new Error('unused'); },
    wait: async () => { throw new Error('unused'); },
  };
}

/** A runtime that makes one call to `t__pay` and handles what comes back as `handle` says. */
function payRuntime(handle: 'propagate' | 'catch'): RuntimePort {
  return {
    bind: (stack, agent) => {
      const once = async (c: CallContext): Promise<RunResult> => {
        try {
          await stack.toolsFor(agent).callTool('t__pay', { n: 1 }, c);
          return { runId: c.runId, status: 'completed', output: 'paid' };
        } catch (err) {
          if (handle === 'propagate') throw err;
          return { runId: c.runId, output: '', ...runEndOf(err) };
        }
      };
      return {
        name: agent.name,
        run: (_input, c) => once(stack.context({ ...c, agent: agent.name })),
        async *stream(_input, c) {
          const r = await once(stack.context({ ...c, agent: agent.name }));
          yield { type: 'run.end', status: r.status, ...(r.reason ? { reason: r.reason } : {}) } as RunEvent;
        },
      };
    },
  };
}

/**
 * A runtime built for RuntimePort 1.0: a thrown tool error becomes tool text and the run completes; a pending result
 * (`ext["sdk.approval"]`) ends the run waiting with needs_input.
 */
function legacyRuntime(): RuntimePort {
  return {
    bind: (stack, agent) => ({
      name: agent.name,
      async run(_input, init) {
        const c = stack.context({ ...init, agent: agent.name });
        let out;
        try {
          out = await stack.toolsFor(agent).callTool('t__pay', { n: 1 }, c);
        } catch (err) {
          return { runId: c.runId, status: 'completed', output: `tool failed: ${err instanceof Error ? err.message : String(err)}` };
        }
        const approval = out.ext?.['sdk.approval'];
        if (typeof approval === 'string') return { runId: c.runId, status: 'waiting', output: '', reason: { code: 'needs_input', layer: 'identity', by: 'approval', detail: approval } };
        return { runId: c.runId, status: 'completed', output: out.text };
      },
    }),
  };
}

async function stackWith(handle: 'propagate' | 'catch' | 'legacy'): Promise<Stack> {
  const runtime = handle === 'legacy'
    ? { ...testAdapter('RuntimePort', 'harness', 'pay', () => legacyRuntime()), portVersion: '1.0.0' }
    : testAdapter('RuntimePort', 'harness', 'pay', () => payRuntime(handle));
  return compose(resolveProfile({
    agents: { a: { model: 'm', tools: ['t__*'] } },
    layers: { runtime: { adapter: 'pay' }, approval: { adapter: 'ask' }, tools: { t: { adapter: 'pay-tools' } } },
    policy: [{ effect: 'ask', tools: ['t__pay'] }],
  }), {
    adapters: [
      runtime,
      testAdapter('ApprovalPort', 'identity', 'ask', () => pendingApproval()),
      testAdapter('ToolPort', 'tool', 'pay-tools', () => fakeTools([{ name: 'pay', risk: 'write' }])),
    ],
  });
}

test('ApprovalPending: stop reason needs_input in the identity layer, run end waiting, structured ext', () => {
  const err = new ApprovalPending('ap-7', { by: 'approvals', tool: 't__pay' });
  assert.deepEqual(err.stopReason, { code: 'needs_input', layer: 'identity', by: 'approvals', detail: 'ap-7' });
  assert.deepEqual(stopReasonOf(err), err.stopReason);
  assert.deepEqual(runEndOf(err), { status: 'waiting', reason: err.stopReason });
  assert.deepEqual(err.approvalExt, { 'sdk.approval': { id: 'ap-7', by: 'approvals', tool: 't__pay' } });
  assert.equal(runEndOf(new Error('x')).status, 'failed');
});

test('governed tools: pendingAs error throws ApprovalPending; the default stays a pending result; onPending sees both', async () => {
  const seen: string[] = [];
  const opts = { policy: [{ effect: 'ask' as const }], approval: pendingApproval(), onPending: (p: ApprovalPending) => { seen.push(p.approval); } };
  const results = governedTools({ t: fakeTools([{ name: 'pay', risk: 'write' }]) }, opts);
  const out = await results.callTool('t__pay', {}, ctx());
  assert.deepEqual(out.ext, { 'sdk.outcome': 'pending', 'sdk.approval': 'ap-1' });
  const errors = governedTools({ t: fakeTools([{ name: 'pay', risk: 'write' }]) }, { ...opts, pendingAs: 'error' });
  await assert.rejects(errors.callTool('t__pay', {}, ctx()), (e: unknown) => e instanceof ApprovalPending && e.approval === 'ap-2' && e.by === 'approvals' && e.tool === 't__pay');
  assert.deepEqual(seen, ['ap-1', 'ap-2']);
});

for (const handle of ['propagate', 'catch'] as const) {
  test(`a run whose call waits for an approval ends waiting with ext["sdk.approval"] (runtime: ${handle})`, async () => {
    const s = await stackWith(handle);
    const r = await (await s.agent('a')).run('pay', { runId: 'run-1' });
    assert.equal(r.status, 'waiting');
    assert.deepEqual(r.reason, { code: 'needs_input', layer: 'identity', by: 'approvals', detail: 'ap-1' });
    assert.deepEqual(r.ext, { 'sdk.approval': { id: 'ap-1', by: 'approvals', tool: 't__pay' } });
    const events: RunEvent[] = [];
    for await (const e of s.host().stream!('a', 'pay')) events.push(e);
    assert.deepEqual(events.at(-1), { type: 'run.end', status: 'waiting', reason: { code: 'needs_input', layer: 'identity', by: 'approvals', detail: 'ap-2' } });
    await s.close();
  });
}

test('a runtime built for RuntimePort 1.0 gets the pending result, so its approval is not lost as a tool error', async () => {
  const s = await stackWith('legacy');
  const r = await (await s.agent('a')).run('pay', { runId: 'run-1' });
  assert.doesNotMatch(r.output, /tool failed/);
  assert.equal(r.status, 'waiting');
  assert.equal(r.reason?.code, 'needs_input');
  assert.deepEqual(r.ext, { 'sdk.approval': { id: 'ap-1', by: 'approvals', tool: 't__pay' } });
  await assert.doesNotReject(s.tools.callTool('t__pay', {}, s.context({ agent: 'a' })), 'stack.tools returns the pending result too');
  await s.close();
});

test('hosted tools return the pending result for channels to pass on', async () => {
  const s = await stackWith('propagate');
  const out = await s.host().tools!().callTool('t__pay', {}, s.context({ agent: 'gateway' }));
  assert.equal(out.ok, false);
  assert.equal(out.ext?.['sdk.approval'], 'ap-1');
  await s.close();
});

test('inboundSessionId: scoped to the caller, malformed values dropped', () => {
  const alice = { kind: 'user' as const, id: 'alice' };
  const a = inboundSessionId('openai', alice, 'thread-1');
  assert.match(a!, /^openai-[0-9a-f]{16}-thread-1$/);
  assert.equal(inboundSessionId('openai', alice, 'thread-1'), a, 'stable');
  assert.notEqual(inboundSessionId('openai', { kind: 'user', id: 'bob' }, 'thread-1'), a, 'another caller, another session');
  assert.equal(inboundSessionId('openai', alice, 'bad value'), undefined);
  assert.equal(inboundSessionId('openai', alice, 'x'.repeat(129)), undefined);
  assert.equal(inboundSessionId('openai', alice, 42), undefined);
});

test('inboundSessionId: no session without a verified caller, so anonymous clients cannot share one', () => {
  assert.equal(inboundSessionId('openai', undefined, 'thread-1'), undefined);
  assert.equal(inboundSessionId('openai', ANONYMOUS, 'thread-1'), undefined);
});

test('ownerDigest: keyed with the sessions secret, the owner hash cannot be matched against known caller ids', async () => {
  const alice = { kind: 'user' as const, id: 'alice' };
  const plain = inboundSessionId('a2a', alice, 'c-1');
  const keyed = inboundSessionId('a2a', alice, 'c-1', ownerDigest('k1'));
  assert.match(keyed!, /^a2a-[0-9a-f]{16}-c-1$/);
  assert.notEqual(keyed, plain);
  assert.notEqual(inboundSessionId('a2a', alice, 'c-1', ownerDigest('k2')), keyed, 'another secret, another digest');
  const secrets: SecretPort = { get: async (n) => (n === 'SESSION_KEY' ? 'k1' : undefined) };
  const s = await compose(resolveProfile({
    agents: { a: { model: 'm' } },
    layers: { secrets: { adapter: 'vault' } },
    sessions: { secret: '${secret:SESSION_KEY}' },
  }), { adapters: [testAdapter('SecretPort', 'infra', 'vault', () => secrets)] });
  assert.equal(inboundSessionId('a2a', alice, 'c-1', s.host().ownerDigest), keyed);
  await s.close();
  await assert.rejects(compose(resolveProfile({ agents: { a: { model: 'm' } }, sessions: { secret: '${secret:SESSION_KEY}' } })), /no secrets adapter/);
});

test('readiness warns on the production tier when inbound adapters run without sessions.secret', async () => {
  const registry = new AdapterRegistry().register(testAdapter('ChannelPort', 'interface', 'chat', () => ({ mount: () => ({ routes: [] }) }), ['prototype', 'production']));
  const config = (sessions?: { secret: string }) => resolveProfile({ agents: { a: { model: 'm' } }, layers: { channels: [{ adapter: 'chat' }] }, ...(sessions ? { sessions } : {}), profiles: { prod: { tier: 'production' } } }, 'prod');
  assert.ok((await readiness(config(), registry)).warnings.some((w) => w.startsWith('sessions.secret is not set')));
  assert.ok(!(await readiness(config({ secret: '${secret:K}' }), registry)).warnings.some((w) => w.startsWith('sessions.secret')));
});
