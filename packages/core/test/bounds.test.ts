import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BoundsExceeded, compose, deadlineSignal, delegationProblems, governedTools, guardedModel, ledgerOf, outboundBounds, priceOf, resolveProfile, runLimits,
  RunLedger, startRun, tighterDelegation, type CallContext, type ModelPort, type RunResult, type RuntimePort, type StackConfig,
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
  assert.equal(ignored.ledger.lineage, undefined, 'ignore drops the lineage the caller sent too');
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
  assert.equal(outboundBounds(ctx, { budget: false, timeoutMs: 1234 })!.bounds.remainingMs, 1234 - 1000, 'the margin comes off the adapter limit too');
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

const ledger = () => new RunLedger({ runId: 'r', hops: 0, maxHops: 4, remainingMs: 10_000, tokens: 100, costUsd: 1, marginMs: 0, minStartMs: 0 });

test('the ledger takes only finite figures >= 0; anything else is unknown and never counts back', () => {
  const a = ledger();
  a.debit({ inputTokens: NaN, outputTokens: 0 }, NaN);
  a.debit({ inputTokens: -1e6, outputTokens: 0 }, -10);
  assert.deepEqual({ spent: a.spentTokens, cost: a.spentCost, usageKnown: a.usageKnown, costKnown: a.costKnown }, { spent: 0, cost: 0, usageKnown: false, costKnown: false });
  a.debit({ inputTokens: 100, outputTokens: 0 }, 0);
  assert.equal(a.check()?.code, 'limit', 'a negative debit earlier did not buy more budget');
  const b = ledger();
  b.reserve().settle({ usage: { inputTokens: Infinity, outputTokens: 1 }, costUsd: -5 });
  assert.deepEqual({ spent: b.spentTokens, cost: b.spentCost, usageKnown: b.usageKnown, costKnown: b.costKnown }, { spent: 100, cost: 1, usageKnown: false, costKnown: false }, 'the reservation stays spent');
  // Prices: an own entry only, never negative or NaN.
  assert.equal(priceOf({ m: { inputPerMTok: 1 } }, 'constructor', 'constructor', { inputTokens: 1, outputTokens: 1 }), undefined);
  assert.equal(priceOf({ m: { inputPerMTok: -5, outputPerMTok: 1e6 } }, 'm', 'm', { inputTokens: 10, outputTokens: 1 }), 1);
  assert.equal(priceOf({ m: { inputPerMTok: 1 } }, 'm', 'm', { inputTokens: NaN, outputTokens: 1 }), undefined);
});

test('a remote run that reports nothing keeps its reservation spent, but the run reports no cost or usage it did not see', async () => {
  let left: CallContext['bounds'];
  const delegating: RuntimePort = {
    bind: (stack, agent) => ({
      name: agent.name,
      async run(_i, c) {
        const ctx = stack.context({ ...c, agent: agent.name });
        outboundBounds(ctx)!.reservation.settle(undefined);
        left = { ...ctx.bounds! };
        return { runId: ctx.runId, status: 'completed', output: 'done' };
      },
    }),
  };
  const { stack } = await stackWith(delegating, { limits: { run: { maxCostUsd: 5, maxTokens: 1000 } } });
  const r = await (await stack.agent('a')).run('hi');
  assert.deepEqual({ costUsd: r.costUsd, usage: r.usage }, { costUsd: undefined, usage: undefined });
  assert.deepEqual({ tokens: left?.tokens, costUsd: left?.costUsd }, { tokens: 0, costUsd: 0 }, 'the budget still counts the reservation');
});

test('a model the price table does not price: stops the run under the stack cost budget, reported under a sent one', async () => {
  const pricing = { other: { inputPerMTok: 1 } };
  const strict = await stackWith(loopRuntime(1), { pipeline: { pricing }, limits: { run: { maxCostUsd: 4 } } });
  const r = await (await strict.stack.agent('a')).run('hi');
  assert.deepEqual({ status: r.status, code: r.reason?.code }, { status: 'stopped', code: 'limit' });
  assert.match(String(r.reason?.detail), /"fake" has no price/);
  assert.equal(strict.requests.length, 1, 'no call after the one whose cost could not be counted');
  assert.ok(strict.records.some((x) => x.type === 'event' && x.name === 'agent.cost.unpriced'));
  const sent = await stackWith(loopRuntime(1), { pipeline: { pricing } });
  const ok = await (await sent.stack.agent('a')).run('hi', { delegation: { remainingMs: 60_000, hops: 0, maxHops: 4, costUsd: 1 } });
  assert.equal(ok.status, 'completed');
  assert.equal(ok.costUsd, undefined);
  assert.ok(sent.records.some((x) => x.type === 'event' && x.name === 'agent.cost.unpriced'));
  // "constructor" is not a price: the inherited property of a plain object never prices a model.
  const proto = await stackWith(loopRuntime(1), { agents: { a: { model: 'constructor' } }, pipeline: { pricing }, limits: { run: { maxCostUsd: 4 } } });
  assert.equal((await (await proto.stack.agent('a')).run('hi')).reason?.code, 'limit');
});

test('a run started with the context of a run in progress is its delegate: hops plus one, lineage, reservation; a loop stops', async () => {
  const seen: CallContext[] = [];
  const nesting: RuntimePort = {
    bind: (stack, agent) => ({
      name: agent.name,
      async run(_i, c) {
        const ctx = stack.context({ ...c, agent: agent.name });
        seen.push(ctx);
        if (seen.length > 10) return { runId: ctx.runId, status: 'completed', output: 'runaway' };
        const child = await (await stack.agent(agent.name)).run('again', ctx);
        return { runId: ctx.runId, status: child.status, output: child.output, ...(child.reason ? { reason: child.reason } : {}) };
      },
    }),
  };
  const { stack } = await stackWith(nesting, { limits: { run: { maxHops: 2, maxTokens: 100 } } });
  const r = await (await stack.agent('a')).run('hi');
  assert.deepEqual(r.reason, { code: 'hop_limit', layer: 'harness', by: 'sdk.hops' });
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map((c) => c.bounds?.hops), [0, 1, 2]);
  assert.notEqual(seen[1]!.runId, seen[0]!.runId);
  assert.deepEqual(seen[2]!.lineage, { rootRunId: seen[0]!.runId, parentRunId: seen[1]!.runId });
  assert.equal(seen[1]!.bounds?.tokens, 100);
  assert.deepEqual(seen[0]!.bounds?.reserved, undefined, 'settled when the delegate ended');

  // An explicit delegation passed along still tightens (the path of an orchestrator calling stacks in process).
  const once: CallContext[] = [];
  const explicit: RuntimePort = {
    bind: (st, agent) => ({
      name: agent.name,
      async run(_i, c) {
        const ctx = st.context({ ...c, agent: agent.name });
        once.push(ctx);
        if (once.length === 1) await (await st.agent(agent.name)).run('x', { ...ctx, delegation: { remainingMs: 5000, hops: 0, maxHops: 1 } });
        return { runId: ctx.runId, status: 'completed', output: '' };
      },
    }),
  };
  const two = await stackWith(explicit);
  await (await two.stack.agent('a')).run('hi');
  assert.deepEqual({ hops: once[1]!.bounds?.hops, maxHops: once[1]!.bounds?.maxHops }, { hops: 1, maxHops: 1 });
});

test('a model stream broken off or failed is still debited', async () => {
  const streaming: ModelPort = {
    name: 's',
    chat: async () => reply('x'),
    async *stream() {
      yield { type: 'text', text: 'a' };
      yield { type: 'end', finish: 'end', usage: { inputTokens: 3, outputTokens: 2 } };
      yield { type: 'text', text: 'late' };
    },
  };
  const m = guardedModel(streaming);
  const { ledger: l } = startRun({ runId: 'r' }, runLimits({}));
  const ctx: CallContext = { runId: 'r', agent: 'a', bounds: l.view };
  for await (const d of m.stream!({ model: 'm', messages: text('q') }, ctx)) if (d.type === 'end') break;
  assert.equal(l.spentTokens, 5);
  const failing: ModelPort = { name: 'f', chat: async () => reply('x'), async *stream() { yield { type: 'text', text: 'a' }; throw new Error('cut'); } };
  await assert.rejects(async () => { for await (const _ of guardedModel(failing).stream!({ model: 'm', messages: text('q') }, ctx)); });
  assert.equal(l.usageKnown, false, 'a failed stream without usage leaves the run usage unknown');
});

test('the deadline is the cause only when its signal fired, not when the clock passed it', async () => {
  const busy: RuntimePort = {
    bind: (stack, agent) => ({
      name: agent.name,
      async run(_i, c) {
        const ctx = stack.context({ ...c, agent: agent.name });
        const until = Date.now() + 40;
        while (Date.now() < until) { /* the timer cannot fire */ }
        return { runId: ctx.runId, status: 'failed', output: '', reason: { code: 'error' } };
      },
    }),
  };
  const { stack } = await stackWith(busy, { limits: { run: { timeoutMs: 10 }, delegation: { minRemainingMs: 0 } } });
  assert.equal((await (await stack.agent('a')).run('hi')).reason?.code, 'error');
});

test('the deadline timer is cleared when the run settles', async () => {
  const { ledger: l } = startRun({ runId: 'r' }, runLimits({ run: { timeoutMs: 20 }, delegation: { minRemainingMs: 0 } }));
  const timer = deadlineSignal(l)!;
  timer.clear();
  await alive(new Promise((r) => setTimeout(r, 40)));
  assert.equal(timer.signal.aborted, false);
});

test('a refused stream counts in agent.bounds.stops', async () => {
  const streaming: RuntimePort = {
    bind: (_s, agent) => ({ name: agent.name, async run() { return { runId: 'x', status: 'completed', output: '' }; }, async *stream() { yield { type: 'run.end', status: 'completed' }; } }),
  };
  const { stack, records } = await stackWith(streaming, { limits: { run: { maxHops: 1 } } });
  for await (const _ of (await stack.agent('a')).stream!('hi', { delegation: { remainingMs: 60_000, hops: 5, maxHops: 9 } }));
  assert.ok(records.some((x) => x.type === 'metric' && x.name === 'agent.bounds.stops' && x.attrs['agent.run.reason'] === 'hop_limit'));
});

test('hosted tools run under the bounds a calling agent sent: ledger, hops passed on, refusal over the hop limit', async () => {
  const log: { name: string; args: unknown; ctx: CallContext }[] = [];
  const { telemetry, records } = recorder();
  const stack = await compose(resolveProfile({ layers: { tools: { t: { adapter: 'ft' } } }, limits: { run: { maxHops: 2 } } }), {
    adapters: [testAdapter('ToolPort', 'tool', 'ft', () => fakeTools([{ name: 'x', risk: 'read' }], log))], telemetry: [telemetry],
  });
  const tools = stack.host().tools!();
  const ok = await tools.callTool('t__x', {}, { runId: 'call-1', agent: 'mcp', delegation: { remainingMs: 30_000, hops: 1, maxHops: 9, rootRunId: 'root', parentRunId: 'p' } });
  assert.equal(ok.ok, true);
  const ctx = log[0]!.ctx;
  assert.deepEqual({ hops: ctx.bounds?.hops, maxHops: ctx.bounds?.maxHops, lineage: ctx.lineage }, { hops: 1, maxHops: 2, lineage: { rootRunId: 'root', parentRunId: 'p' } });
  assert.equal(outboundBounds(ctx, { refuse: false })!.bounds.hops, 2);
  const refused = await tools.callTool('t__x', {}, { runId: 'call-2', agent: 'mcp', delegation: { remainingMs: 30_000, hops: 3, maxHops: 9 } });
  assert.deepEqual({ ok: refused.ok, text: refused.text }, { ok: false, text: 'Stopped by the run bounds: hop_limit' });
  assert.equal(log.length, 1, 'the tool did not run');
  assert.ok(records.some((x) => x.type === 'metric' && x.name === 'agent.bounds.stops'));
  // A context with only the bounds it received passes them on.
  assert.equal(outboundBounds({ runId: 'c', agent: 'a', delegation: { remainingMs: 5000, hops: 1, maxHops: 3, rootRunId: 'root' } }, { refuse: false })!.bounds.rootRunId, 'root');
  await stack.close();
});
