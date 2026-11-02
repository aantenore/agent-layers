import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BoundsExceeded, compose, delegationProblems, governedTools, guardedModel, ledgerOf, outboundBounds, resolveProfile, runLimits, startRun,
  tighterDelegation, type CallContext, type RunResult, type RuntimePort, type StackConfig,
} from '../src/index.ts';
import { fakeModel, fakeTools, recorder, reply, testAdapter } from './helpers.ts';

// The deadline and abort timers are unref'd on purpose; a ref'd interval keeps the event loop (and the test runner) alive while a test awaits one.
const alive = async <T>(pending: Promise<T>): Promise<T> => {
  const keep = setInterval(() => {}, 1000);
  try { return await pending; } finally { clearInterval(keep); }
};

const text = (t: string) => [{ role: 'user' as const, parts: [{ type: 'text' as const, text: t }] }];

/** Calls the model `turns` times, then completes; a thrown error propagates to the host. */
const loopRuntime = (turns: number, seen: CallContext[] = []): RuntimePort => ({
  bind: (stack, agent) => ({
    name: agent.name,
    async run(_input, c) {
      const ctx = stack.context({ ...c, agent: agent.name });
      seen.push(ctx);
      for (let i = 0; i < turns; i++) await stack.modelFor(agent).chat({ model: agent.model, messages: text('q') }, ctx);
      return { runId: ctx.runId, status: 'completed', output: 'done' };
    },
  }),
});

/** Waits for the run's signal, then ends as basic runtimes do on an abort. */
const waitingRuntime: RuntimePort = {
  bind: (stack, agent) => ({
    name: agent.name,
    async run(_input, c) {
      const ctx = stack.context({ ...c, agent: agent.name });
      await new Promise((resolve) => ctx.signal?.addEventListener('abort', resolve, { once: true }));
      return { runId: ctx.runId, status: 'stopped', output: '', reason: { code: 'aborted' } };
    },
  }),
};

async function stackWith(runtime: RuntimePort, extra: Partial<StackConfig> = {}, model = fakeModel()) {
  const { telemetry, records } = recorder();
  const stack = await compose(resolveProfile({ agents: { a: { model: 'm' } }, layers: { model: { adapter: 'fake-model' }, runtime: { adapter: 'rt' } }, ...extra }), {
    adapters: [testAdapter('ModelPort', 'llm', 'fake-model', () => model.model), testAdapter('RuntimePort', 'harness', 'rt', () => runtime)],
    telemetry: [telemetry],
  });
  return { stack, records, requests: model.requests };
}

test('startRun: inbound bounds only tighten; hops take the larger of the sent count and the verified actor chain', () => {
  const limits = runLimits({ run: { timeoutMs: 10_000, maxHops: 4, maxTokens: 1000 } });
  const now = 1_000_000;
  const loose = startRun({ runId: 'r', delegation: { remainingMs: 99_999, hops: 0, maxHops: 9, tokens: 5000 } }, limits, now);
  assert.equal(loose.refused, undefined);
  assert.equal(loose.ledger.deadline, now + 10_000);
  assert.equal(loose.ledger.view.maxHops, 4);
  assert.equal(loose.ledger.view.tokens, 1000);
  const tight = startRun({ runId: 'r', delegation: { remainingMs: 3000, hops: 1, maxHops: 2, tokens: 10, costUsd: 0.5 } }, limits, now);
  assert.equal(tight.ledger.deadline, now + 3000);
  assert.deepEqual({ ...tight.ledger.view }, { deadlineAt: new Date(now + 3000).toISOString(), hops: 1, maxHops: 2, tokens: 10, costUsd: 0.5, reserved: undefined });
  // A caller that sends hops 0 cannot reset a chain its credential verifies.
  const caller = { id: 'u', kind: 'user' as const, roles: [], scopes: [], actors: [{ id: 'a', kind: 'agent' as const }, { id: 'b', kind: 'agent' as const }] };
  assert.equal(startRun({ runId: 'r', caller, delegation: { remainingMs: 5000, hops: 0, maxHops: 4 } }, limits, now).ledger.hops, 2);
  assert.equal(startRun({ runId: 'r', caller: { id: 'svc', kind: 'agent', roles: [], scopes: [] } }, limits, now).ledger.hops, 1);
});

test('startRun: refuses above the hop limit and with too little time; ignore mode drops what the caller sent', () => {
  const limits = runLimits({ run: { maxHops: 2 } });
  assert.deepEqual(startRun({ runId: 'r', delegation: { remainingMs: 60_000, hops: 3, maxHops: 9 } }, limits).refused, { code: 'hop_limit', layer: 'harness', by: 'sdk.hops' });
  assert.deepEqual(startRun({ runId: 'r', delegation: { remainingMs: 500, hops: 1, maxHops: 9 } }, limits).refused, { code: 'timeout', layer: 'harness', by: 'sdk.deadline' });
  const ignored = startRun({ runId: 'r', delegation: { remainingMs: 500, hops: 3, maxHops: 9, rootRunId: 'root', parentRunId: 'p' } }, runLimits({ run: { maxHops: 2 }, delegation: { inbound: 'ignore' } }));
  assert.equal(ignored.refused, undefined);
  assert.equal(ignored.ledger.hops, 0);
  assert.deepEqual(ignored.ledger.lineage, { rootRunId: 'root', parentRunId: 'p' }, 'lineage is kept for correlation');
});

test('a run above the hop limit stops before any model call, with hop_limit', async () => {
  const { stack, records, requests } = await stackWith(loopRuntime(1), { limits: { run: { maxHops: 1 } } });
  const r = await (await stack.agent('a')).run('hi', { delegation: { remainingMs: 60_000, hops: 2, maxHops: 5 } });
  assert.equal(r.status, 'stopped');
  assert.deepEqual(r.reason, { code: 'hop_limit', layer: 'harness', by: 'sdk.hops' });
  assert.equal(requests.length, 0);
  assert.ok(records.some((x) => x.type === 'metric' && x.name === 'agent.bounds.stops' && x.attrs['agent.run.reason'] === 'hop_limit'));
  const span = records.find((x) => x.type === 'span' && x.name === 'agent.run');
  assert.equal(span?.attrs['agent.run.hops'], 2);
  assert.equal(span?.attrs['agent.run.max_hops'], 1);
});

test('every run gets bounds from the core defaults; the delegation the caller sent is not in the run context', async () => {
  const seen: CallContext[] = [];
  const { stack } = await stackWith(loopRuntime(1, seen));
  await (await stack.agent('a')).run('hi', { delegation: { remainingMs: 60_000, hops: 1, maxHops: 4, rootRunId: 'root-1', parentRunId: 'parent-1' } });
  const ctx = seen[0]!;
  assert.equal(ctx.delegation, undefined);
  assert.equal(ctx.bounds?.hops, 1);
  assert.equal(ctx.bounds?.maxHops, 4);
  assert.ok(Date.parse(ctx.bounds!.deadlineAt!) - Date.now() <= 60_000);
  assert.deepEqual(ctx.lineage, { rootRunId: 'root-1', parentRunId: 'parent-1' });
  assert.ok(ctx.signal, 'the deadline arms the run signal');
  // In process, without a caller's bounds: the core's defaults (300 s, 4 hops).
  await (await stack.agent('a')).run('hi');
  assert.equal(seen[1]!.bounds?.hops, 0);
  assert.ok(Date.parse(seen[1]!.bounds!.deadlineAt!) - Date.now() > 290_000);
});

test('the token budget is enforced in the model pipeline, whatever the runtime: the next call stops the run with limit', async () => {
  const { stack, requests } = await stackWith(loopRuntime(3), { limits: { run: { maxTokens: 6 } } });
  const r = await (await stack.agent('a')).run('hi');
  // Each reply spends 5 tokens: the second call still has 1 token left, the third is refused.
  assert.equal(requests.length, 2);
  assert.equal(r.status, 'stopped');
  assert.deepEqual(r.reason, { code: 'limit', layer: 'harness', by: 'sdk.budget' });
  assert.deepEqual(r.usage, { inputTokens: 6, outputTokens: 4 });
});

test('model prices give the run its cost and enforce the cost budget', async () => {
  const pricing = { fake: { inputPerMTok: 1_000_000, outputPerMTok: 0 } };
  const priced = await stackWith(loopRuntime(2), { pipeline: { pricing } });
  assert.equal((await (await priced.stack.agent('a')).run('hi')).costUsd, 6);
  const capped = await stackWith(loopRuntime(3), { pipeline: { pricing }, limits: { run: { maxCostUsd: 4 } } });
  const r = await (await capped.stack.agent('a')).run('hi');
  assert.equal(r.reason?.code, 'limit');
  assert.equal(capped.requests.length, 2);
});

test('the deadline aborts the run; the result says timeout, by the core deadline', async () => {
  const { stack, records } = await stackWith(waitingRuntime, { limits: { run: { timeoutMs: 30 }, delegation: { minRemainingMs: 0 } } });
  const r = await alive((await stack.agent('a')).run('hi'));
  assert.equal(r.status, 'stopped');
  assert.deepEqual(r.reason, { code: 'timeout', layer: 'harness', by: 'sdk.deadline' });
  assert.ok(records.some((x) => x.type === 'metric' && x.name === 'agent.bounds.stops' && x.attrs['agent.run.reason'] === 'timeout'));
});

test('a caller abort stays an abort, not a deadline stop', async () => {
  const { stack } = await stackWith(waitingRuntime);
  const r = await alive((await stack.agent('a')).run('hi', { signal: AbortSignal.timeout(10) }));
  assert.equal(r.reason?.code, 'aborted');
});

test('a bound thrown out of the runtime becomes the stopped result', async () => {
  const throwing: RuntimePort = { bind: (_s, agent) => ({ name: agent.name, async run(): Promise<RunResult> { throw new BoundsExceeded({ code: 'limit', layer: 'harness', by: 'sdk.budget' }); } }) };
  const { stack } = await stackWith(throwing);
  const r = await (await stack.agent('a')).run('hi');
  assert.deepEqual({ status: r.status, code: r.reason?.code }, { status: 'stopped', code: 'limit' });
});

test('streamed runs are bounded like runs', async () => {
  const streaming: RuntimePort = {
    bind: (stack, agent) => ({
      name: agent.name,
      async run() { return { runId: 'x', status: 'completed', output: '' }; },
      async *stream(_input, c) {
        const ctx = stack.context({ ...c, agent: agent.name });
        try {
          for (;;) await stack.modelFor(agent).chat({ model: agent.model, messages: text('q') }, ctx);
        } catch (err) {
          yield { type: 'run.end', status: 'stopped', reason: (err as BoundsExceeded).stopReason };
        }
      },
    }),
  };
  const { stack } = await stackWith(streaming, { limits: { run: { maxTokens: 5 } } });
  const agent = await stack.agent('a');
  const events = [];
  for await (const e of agent.stream!('hi')) events.push(e);
  assert.deepEqual(events.at(-1), { type: 'run.end', status: 'stopped', reason: { code: 'limit', layer: 'harness', by: 'sdk.budget' }, usage: { inputTokens: 3, outputTokens: 2 } });
  const refused = [];
  for await (const e of agent.stream!('hi', { delegation: { remainingMs: 60_000, hops: 9, maxHops: 9 } })) refused.push(e);
  assert.deepEqual(refused, [{ type: 'run.end', status: 'stopped', reason: { code: 'hop_limit', layer: 'harness', by: 'sdk.hops' } }]);
});

test('outboundBounds: hops plus one, time minus the margin, a reservation settled with what the remote run reports', () => {
  const { ledger } = startRun({ runId: 'run-a', delegation: { remainingMs: 20_000, hops: 1, maxHops: 3, tokens: 1000, costUsd: 2, rootRunId: 'root', parentRunId: 'p' } }, runLimits({}));
  const ctx: CallContext = { runId: 'run-a', agent: 'a', bounds: ledger.view, lineage: ledger.lineage! };
  const half = outboundBounds({ ...ctx }, { share: 0.5 })!;
  assert.equal(half.bounds.hops, 2);
  assert.equal(half.bounds.maxHops, 3);
  assert.ok(half.bounds.remainingMs <= 19_000 && half.bounds.remainingMs > 18_000, `remaining ${half.bounds.remainingMs}`);
  assert.deepEqual({ tokens: half.bounds.tokens, costUsd: half.bounds.costUsd, root: half.bounds.rootRunId, parent: half.bounds.parentRunId }, { tokens: 500, costUsd: 1, root: 'root', parent: 'run-a' });
  assert.deepEqual(ctx.bounds?.reserved, { tokens: 500, costUsd: 1 });
  // A second call in parallel sees only what is not reserved.
  const rest = outboundBounds(ctx)!;
  assert.equal(rest.bounds.tokens, 500);
  half.reservation.settle({ usage: { inputTokens: 100, outputTokens: 20 }, costUsd: 0.25 });
  half.reservation.settle({ usage: { inputTokens: 999, outputTokens: 999 } });
  rest.reservation.settle();
  assert.equal(ctx.bounds?.tokens, 1000 - 120 - 500, 'an unreported call keeps its whole reservation spent');
  assert.equal(ctx.bounds?.costUsd, 2 - 0.25 - 1);
  assert.equal(ctx.bounds?.reserved, undefined);
  // The timeout of the adapter caps the sent time.
  assert.equal(outboundBounds(ctx, { budget: false, timeoutMs: 1234 })!.bounds.remainingMs, 1234);
  assert.equal(outboundBounds({ runId: 'x', agent: 'a' }), undefined, 'no bounds outside a run');
});

test('outboundBounds refuses locally: over the hop limit, too little time, nothing left to spend', () => {
  const at = (d: Parameters<typeof startRun>[0]['delegation'], limits = runLimits({})) => {
    const { ledger } = startRun({ runId: 'r', ...(d ? { delegation: d } : {}) }, limits);
    return { runId: 'r', agent: 'a', bounds: ledger.view } as CallContext;
  };
  const refused = (ctx: CallContext) => { try { outboundBounds(ctx); return undefined; } catch (err) { return (err as BoundsExceeded).stopReason.code; } };
  assert.equal(refused(at({ remainingMs: 60_000, hops: 3, maxHops: 3 })), 'hop_limit');
  assert.equal(refused(at({ remainingMs: 1500, hops: 0, maxHops: 3 })), 'timeout');
  assert.equal(refused(at({ remainingMs: 60_000, hops: 0, maxHops: 3, tokens: 0 })), 'limit');
});

test('governed tools refuse a call once the run has no time left; tools get the run bounds', async () => {
  const log: { name: string; args: unknown; ctx: CallContext }[] = [];
  const tools = governedTools({ t: fakeTools([{ name: 'x', risk: 'read' }], log) });
  const live = startRun({ runId: 'r' }, runLimits({})).ledger;
  assert.equal((await tools.callTool('t__x', {}, { runId: 'r', agent: 'a', bounds: live.view })).ok, true);
  assert.equal(log[0]!.ctx.bounds?.hops, 0);
  const past = startRun({ runId: 'r' }, runLimits({ run: { timeoutMs: 1 }, delegation: { minRemainingMs: 0 } }), Date.now() - 10).ledger;
  const out = await tools.callTool('t__x', {}, { runId: 'r', agent: 'a', bounds: past.view });
  assert.deepEqual({ ok: out.ok, outcome: out.ext?.['sdk.outcome'] }, { ok: false, outcome: 'error' });
  assert.equal(log.length, 1);
});

test('guarded model: cache hits spend nothing', async () => {
  const store = new Map<string, unknown>();
  const cache = { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, v); }, delete: async () => {} };
  const m = guardedModel(fakeModel(() => reply('a')).model, { cache: cache as never });
  const { ledger } = startRun({ runId: 'r' }, runLimits({}));
  const ctx: CallContext = { runId: 'r', agent: 'a', bounds: ledger.view };
  await m.chat({ model: 'm', messages: text('q') }, ctx);
  await m.chat({ model: 'm', messages: text('q') }, ctx);
  assert.equal(ledgerOf(ctx)?.spentTokens, 5);
});

test('delegationProblems and tighterDelegation', () => {
  assert.deepEqual(delegationProblems({ remainingMs: 10, hops: 1, maxHops: 2 }), []);
  assert.equal(delegationProblems({ remainingMs: -1, hops: 1.5, maxHops: 2, tokens: 'x', rootRunId: '' }).length, 4);
  assert.deepEqual(delegationProblems(null), ['must be an object']);
  assert.deepEqual(
    tighterDelegation({ remainingMs: 10, hops: 1, maxHops: 5, tokens: 9 }, { remainingMs: 20, hops: 2, maxHops: 3, costUsd: 1, rootRunId: 'r' }),
    { remainingMs: 10, hops: 2, maxHops: 3, tokens: 9, costUsd: 1, rootRunId: 'r' },
  );
});
