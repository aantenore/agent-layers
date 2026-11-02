// Resume and cancel of runs: the waiting record, who may resume, deterministic resume and the re-run fallback.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApprovalPending, compose, memoryRunBook, resolveProfile, RunRefused, storeRunBook,
  type AccessQuestion, type Approval, type ApprovalPort, type AuthorizationPort, type CallContext, type Caller, type JsonValue,
  type RunResult, type RuntimePort, type Stack, type StoreEntry, type StorePort, type WaitingRun,
} from '../src/index.ts';
import { fakeTools, testAdapter } from './helpers.ts';

const ann: Caller = { id: 'ann', kind: 'user', roles: [], scopes: [], credential: 'ann-token' };
const bob: Caller = { id: 'bob', kind: 'user', roles: ['reviewer'], scopes: [] };

/** Approvals in memory, with lookup (consumed once) and cancel. */
function memoryApprovals(): ApprovalPort & { all: Map<string, Approval & { consumed?: boolean }> } {
  const all = new Map<string, Approval & { consumed?: boolean }>();
  let n = 0;
  const must = (id: string) => {
    const a = all.get(id);
    if (!a || a.status !== 'pending') throw new Error('not pending');
    return a;
  };
  return {
    name: 'approvals', all,
    async request(request) { const a: Approval = { id: `ap-${++n}`, status: 'pending', request }; all.set(a.id, a); return a; },
    get: async (id) => all.get(id),
    async decide(id, d) { const a = must(id); Object.assign(a, { status: d.approved ? 'approved' : 'denied', ...(d.by ? { decidedBy: d.by } : {}) }); return a; },
    wait: async (id) => all.get(id)!,
    async lookup(key, o) {
      const a = [...all.values()].reverse().find((x) => x.request.key === key && !x.consumed);
      if (a && o?.consume && a.status === 'approved') a.consumed = true;
      return a;
    },
    async cancel(id, o) { const a = must(id); Object.assign(a, { status: 'cancelled', ...(o?.by ? { decidedBy: o.by } : {}) }); return a; },
  };
}

/** Authorization that allows what `allow` says, and records every question. */
function authz(allow: (q: AccessQuestion) => boolean, asked: AccessQuestion[] = []): AuthorizationPort {
  return { name: 'authz', evaluate: async (q) => { asked.push(q); return { allowed: allow(q) }; } };
}

/** A store in memory with versions and compare-and-set, as StorePort describes it. */
function memoryStore(): StorePort & { keys: Map<string, StoreEntry> } {
  const keys = new Map<string, StoreEntry>();
  let version = 0;
  return {
    keys,
    get: async (key) => (keys.has(key) ? structuredClone(keys.get(key)!) : undefined),
    async set(key, value, opts) {
      const current = keys.get(key)?.version ?? 0;
      if (opts?.ifVersion !== undefined && opts.ifVersion !== current) return { ok: false, ...(current ? { version: current } : {}) };
      if (JSON.stringify(value).length > 65_536) throw new Error('value too large');
      keys.set(key, { value: structuredClone(value), version: ++version });
      return { ok: true, version };
    },
    async delete(key) { const existed = keys.delete(key); return { ok: true, existed }; },
  };
}

/**
 * A runtime that pays once: the call to `t__pay` waits for an approval, the run ends waiting with a checkpoint (the
 * call), and `resume` makes exactly that call again. `runs` and `resumes` count what the host asked for.
 */
function payRuntime(log: { runs: unknown[]; resumes: { checkpoint: JsonValue; answer: unknown }[] }, resumable = true): RuntimePort {
  return {
    bind: (stack, agent) => {
      const pay = async (args: Record<string, unknown>, c: CallContext): Promise<RunResult> => {
        try {
          const out = await stack.toolsFor(agent).callTool('t__pay', args, c);
          return { runId: c.runId, status: 'completed', output: out.text };
        } catch (err) {
          if (!(err instanceof ApprovalPending)) throw err;
          return { runId: c.runId, status: 'waiting', output: '', reason: err.stopReason, checkpoint: { args } as JsonValue };
        }
      };
      return {
        name: agent.name,
        async run(input, init) {
          log.runs.push(input);
          if (input === 'hang') {
            return new Promise<RunResult>((resolve) => init!.signal!.addEventListener('abort', () => resolve({ runId: init!.runId!, status: 'stopped', output: '', reason: { code: 'aborted' } })));
          }
          return pay({ amount: Number(String(input).replace(/\D/g, '')) || 1 }, stack.context({ ...init, agent: agent.name }));
        },
        ...(resumable ? {
          async resume(checkpoint: JsonValue, answer: unknown, init?: Partial<CallContext>) {
            log.resumes.push({ checkpoint, answer });
            return pay((checkpoint as { args: Record<string, unknown> }).args, stack.context({ ...init, agent: agent.name }));
          },
        } : {}),
      };
    },
  };
}

async function setup(opts: { resumable?: boolean; allow?: (q: AccessQuestion) => boolean; store?: StorePort } = {}) {
  const log = { runs: [] as unknown[], resumes: [] as { checkpoint: JsonValue; answer: unknown }[] };
  const calls: { name: string; args: unknown; ctx: CallContext }[] = [];
  const approvals = memoryApprovals();
  const asked: AccessQuestion[] = [];
  const stack = await compose(resolveProfile({
    agents: { a: { model: 'm', tools: ['t__*'] } },
    layers: {
      runtime: { adapter: 'pay' }, approval: { adapter: 'ask' }, tools: { t: { adapter: 'pay-tools' } }, authorization: { adapter: 'authz' },
      ...(opts.store ? { store: { adapter: 'kv' } } : {}),
    },
    policy: [{ effect: 'ask', tools: ['t__pay'] }],
  }), {
    adapters: [
      testAdapter('RuntimePort', 'harness', 'pay', () => payRuntime(log, opts.resumable ?? true)),
      testAdapter('ApprovalPort', 'identity', 'ask', () => approvals),
      testAdapter('ToolPort', 'tool', 'pay-tools', () => fakeTools([{ name: 'pay', risk: 'write' }], calls)),
      testAdapter('AuthorizationPort', 'identity', 'authz', () => authz((q) => (q.action === 'call' ? true : (opts.allow ?? (() => false))(q)), asked)),
      ...(opts.store ? [testAdapter('StorePort', 'harness', 'kv', () => opts.store)] : []),
    ],
  });
  return { stack, log, calls, approvals, asked };
}

const decideRule = (q: AccessQuestion) => q.action === 'decide' && q.caller.id === 'ann';

async function waitingRun(stack: Stack, input = 'pay 5', caller: Caller = ann): Promise<RunResult> {
  const r = await (await stack.agent('a')).run(input, { caller, sessionId: 's-1' });
  assert.equal(r.status, 'waiting');
  assert.equal(r.checkpoint, undefined, 'the checkpoint never leaves the stack');
  return r;
}

test('the owner resumes with a decision: the runtime continues from its checkpoint and runs the call once', async () => {
  const { stack, log, calls, approvals } = await setup({ allow: decideRule });
  const first = await waitingRun(stack);
  const id = (first.ext?.['sdk.approval'] as { id: string }).id;
  const done = await stack.resume(first.runId, { approval: { id, approved: true } }, { caller: { ...ann, credential: 'fresh' } });
  assert.equal(done.status, 'completed');
  assert.equal(done.runId, first.runId, 'the run keeps its id');
  assert.equal(log.resumes.length, 1);
  assert.deepEqual(log.resumes[0]!.checkpoint, { args: { amount: 5 } });
  assert.deepEqual(calls.map((c) => c.args), [{ amount: 5 }]);
  assert.equal(calls[0]!.ctx.caller?.credential, 'fresh', 'the owner\'s fresh credential is used');
  assert.equal(calls[0]!.ctx.sessionId, 's-1');
  assert.equal(approvals.all.get(id)!.decidedBy, 'user:ann');
  await assert.rejects(stack.resume(first.runId, { approval: { id, approved: true } }, { caller: ann }), (e: RunRefused) => e.kind === 'not_found', 'a run that ended is no longer kept');
  await stack.close();
});

test('another caller may resume only when authorization lets it decide the approval', async () => {
  const { stack, calls } = await setup({ allow: (q) => q.action === 'decide' && q.caller.id === 'bob' });
  const first = await waitingRun(stack);
  const id = (first.ext?.['sdk.approval'] as { id: string }).id;
  const eve: Caller = { id: 'eve', kind: 'user', roles: [], scopes: [] };
  await assert.rejects(stack.resume(first.runId, { approval: { id, approved: true } }, { caller: eve }), (e: RunRefused) => e.kind === 'forbidden');
  const done = await stack.resume(first.runId, { approval: { id, approved: true } }, { caller: bob });
  assert.equal(done.status, 'completed');
  assert.equal(calls[0]!.ctx.caller?.id, 'ann', 'the run goes on as the caller that started it');
  assert.equal(calls[0]!.ctx.caller?.credential, undefined, 'without a credential it was never given');
  await stack.close();
});

test('the owner needs authorization to decide; an input answer waits until the approval is decided', async () => {
  const { stack, approvals } = await setup();
  const first = await waitingRun(stack);
  const id = (first.ext?.['sdk.approval'] as { id: string }).id;
  await assert.rejects(stack.resume(first.runId, { approval: { id, approved: true } }, { caller: ann }), (e: RunRefused) => e.kind === 'forbidden');
  await assert.rejects(stack.resume(first.runId, { input: 'go on' }, { caller: ann }), (e: RunRefused) => e.kind === 'conflict');
  await assert.rejects(stack.resume(first.runId, { approval: { id: 'other', approved: true } }, { caller: ann }), (e: RunRefused) => e.kind === 'invalid');
  await assert.rejects(stack.resume(first.runId, { nope: 1 } as never, { caller: ann }), (e: RunRefused) => e.kind === 'invalid');
  // Decided elsewhere (the approval routes): the owner continues with input, or with the same decision.
  await approvals.decide(id, { approved: true, by: 'user:bob' });
  await assert.rejects(stack.resume(first.runId, { approval: { id, approved: false } }, { caller: ann }), (e: RunRefused) => e.kind === 'conflict');
  assert.equal((await stack.resume(first.runId, { input: 'go on' }, { caller: ann })).status, 'completed');
  await stack.close();
});

test('a runtime without resume runs the agent again from its input, in the same session and run', async () => {
  const { stack, log, calls } = await setup({ resumable: false, allow: decideRule });
  const first = await waitingRun(stack, 'pay 7');
  const id = (first.ext?.['sdk.approval'] as { id: string }).id;
  const done = await stack.resume(first.runId, { approval: { id, approved: true } }, { caller: ann });
  assert.equal(done.status, 'completed', 'the same call in the same run finds the decision');
  assert.deepEqual(log.runs, ['pay 7', 'pay 7']);
  assert.deepEqual(calls.map((c) => c.args), [{ amount: 7 }]);
  await stack.close();
});

test('cancel withdraws a waiting run and its approval; a cancelled run cannot be resumed', async () => {
  const { stack, approvals, asked } = await setup({ allow: (q) => q.action === 'decide' && q.caller.id === 'bob' });
  const first = await waitingRun(stack);
  const id = (first.ext?.['sdk.approval'] as { id: string }).id;
  const eve: Caller = { id: 'eve', kind: 'user', roles: [], scopes: [] };
  await assert.rejects(stack.cancel(first.runId, { by: eve }), (e: RunRefused) => e.kind === 'forbidden');
  assert.deepEqual(await stack.cancel(first.runId, { by: bob, reason: 'not needed' }), { runId: first.runId, outcome: 'cancelled' });
  assert.ok(asked.some((q) => q.action === 'decide' && q.target.kind === 'approval' && q.target.id === id), 'another caller needs decide on the approval');
  assert.equal(approvals.all.get(id)!.status, 'cancelled');
  assert.equal(approvals.all.get(id)!.decidedBy, 'user:bob');
  await assert.rejects(stack.resume(first.runId, { input: 'go on' }, { caller: ann }), (e: RunRefused) => e.kind === 'conflict');
  await assert.rejects(stack.cancel(first.runId, { by: ann }), (e: RunRefused) => e.kind === 'conflict');
  await assert.rejects(stack.cancel('no-such-run', { by: ann }), (e: RunRefused) => e.kind === 'not_found');
  await stack.close();
});

test('cancel aborts a run in flight in this process', async () => {
  const { stack } = await setup();
  const running = (await stack.agent('a')).run('hang', { caller: ann, runId: 'r-hang' });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await stack.cancel('r-hang', { by: ann }), { runId: 'r-hang', outcome: 'aborted' });
  const r = await running;
  assert.equal(r.status, 'stopped');
  assert.equal(r.reason?.code, 'aborted');
  await stack.close();
});

test('with a store, waiting runs live there: a large checkpoint in parts, no credential, the record gone once resumed', async () => {
  const store = memoryStore();
  const { stack } = await setup({ store, allow: decideRule });
  const first = await waitingRun(stack);
  const keys = [...store.keys.keys()];
  assert.ok(keys.length >= 1 && keys.every((k) => k.startsWith('sdk.run.')));
  assert.ok(!JSON.stringify([...store.keys.values()]).includes('ann-token'), 'never a credential');
  const id = (first.ext?.['sdk.approval'] as { id: string }).id;
  assert.equal((await stack.resume(first.runId, { approval: { id, approved: true } }, { caller: ann })).status, 'completed');
  assert.equal(store.keys.size, 0);

  const book = storeRunBook(store, 60_000);
  const big = { text: 'é'.repeat(120_000) };
  const rec: WaitingRun = { runId: 'r-big', agent: 'a', status: 'waiting', input: 'x', at: new Date().toISOString() };
  await book.put(rec, { checkpoint: big });
  assert.ok(store.keys.size > 2, 'the checkpoint is split into parts');
  assert.deepEqual(await book.checkpoint('r-big'), big);
  const { version } = (await book.get('r-big'))!;
  assert.equal(await book.put({ ...rec, status: 'resuming' }, { ifVersion: version + 1 }), false, 'compare-and-set');
  assert.equal(await book.put({ ...rec, status: 'resuming' }, { ifVersion: version }), true);
  assert.deepEqual(await book.checkpoint('r-big'), big, 'a status change keeps the checkpoint');
  await book.delete('r-big');
  assert.equal(store.keys.size, 0);
  await stack.close();
});

test('the memory book keeps at most its limit, oldest dropped first, and forgets expired runs', async () => {
  const book = memoryRunBook(60_000, 2);
  const rec = (runId: string): WaitingRun => ({ runId, agent: 'a', status: 'waiting', input: 'x', at: '' });
  for (const id of ['r1', 'r2', 'r3']) await book.put(rec(id));
  assert.equal(await book.get('r1'), undefined);
  assert.ok(await book.get('r3'));
  const short = memoryRunBook(1, 10);
  await short.put(rec('r1'), { checkpoint: { a: 1 } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await short.get('r1'), undefined);
});
