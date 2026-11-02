import { errorMessage, RunRefused, type ApprovalPending } from './errors.ts';
import { ATTR, EVENT } from './names.ts';
import type { CallContext } from './ports/base.ts';
import type { CancelOptions, CancelResult } from './ports/channel.ts';
import { ANONYMOUS, publicCaller, type AccessQuestion, type AccessTarget, type Action, type Approval, type ApprovalPort, type AuthorizationPort, type Caller, type PublicCaller } from './ports/identity.ts';
import type { ResumeAnswer, RunInput, RunnableAgent, RunResult, StopReason } from './ports/runtime.ts';
import type { JsonValue, StorePort } from './ports/store.ts';
import type { TelemetryPort } from './ports/telemetry.ts';
import { isPlainObject, sha256 } from './util.ts';

/**
 * A run that ended `waiting`, as the host keeps it to resume it: plain JSON, never a credential. `resuming` while a
 * resume holds it, `cancelled` once withdrawn (a resume is then refused until the record expires).
 */
export interface WaitingRun {
  runId: string;
  agent: string;
  status: 'waiting' | 'resuming' | 'cancelled';
  /** The run's input: what a runtime without `resume` runs again. */
  input: RunInput;
  /** Who started the run, without the credential. Absent: anonymous. */
  caller?: PublicCaller;
  sessionId?: string;
  reason?: StopReason;
  /** The governed call that waits for an approval: its id, the approval instance, the prefixed tool and its arguments. */
  pending?: { approval: string; by?: string; tool?: string; args?: Record<string, unknown> };
  /** ISO time the run started waiting. */
  at: string;
  cancelled?: { by: string; reason?: string; at: string };
}

/** Where waiting runs are kept: the stack's store when configured, else memory. */
export interface RunBook {
  /** Where the runs are kept: `store` or `memory`. */
  readonly kind: 'store' | 'memory';
  get(runId: string): Promise<{ run: WaitingRun; version: number } | undefined>;
  /** The runtime checkpoint kept with the run, if any. */
  checkpoint(runId: string): Promise<JsonValue | undefined>;
  /**
   * Writes the run; with `ifVersion`, only when its current version is that one (false on a conflict). `checkpoint`
   * replaces the kept checkpoint (`null` removes it); absent, the kept one stays.
   */
  put(run: WaitingRun, opts?: { ifVersion?: number; checkpoint?: JsonValue | null }): Promise<boolean>;
  delete(runId: string): Promise<void>;
}

/** Characters of base64 per stored part of a checkpoint: one part stays under 64 KiB of JSON. */
const PART_CHARS = 49_152;
const RUN_KEY = (runId: string) => `sdk.run.${sha256(runId)}`;

/** A run book over a StorePort: one key per run, the checkpoint in base64 parts beside it, all with the same expiry. */
export function storeRunBook(store: StorePort, ttlMs: number): RunBook {
  const ttl = Number.isFinite(ttlMs) ? { ttlMs } : {};
  const partKey = (runId: string, i: number) => `${RUN_KEY(runId)}.${i}`;
  type Stored = WaitingRun & { parts?: number };
  const read = async (runId: string) => {
    const e = await store.get(RUN_KEY(runId));
    return e ? { stored: e.value as unknown as Stored, version: e.version } : undefined;
  };
  const dropParts = async (runId: string, from: number, to: number) => {
    for (let i = from; i < to; i++) await store.delete(partKey(runId, i));
  };
  return {
    kind: 'store',
    async get(runId) {
      const found = await read(runId);
      if (!found) return undefined;
      const { parts: _parts, ...run } = found.stored;
      return { run, version: found.version };
    },
    async checkpoint(runId) {
      const found = await read(runId);
      const n = found?.stored.parts ?? 0;
      if (!n) return undefined;
      let text = '';
      for (let i = 0; i < n; i++) {
        const part = await store.get(partKey(runId, i));
        if (typeof part?.value !== 'string') return undefined;
        text += part.value;
      }
      return JSON.parse(Buffer.from(text, 'base64').toString('utf8')) as JsonValue;
    },
    async put(run, opts = {}) {
      const before = await read(run.runId);
      const had = before?.stored.parts ?? 0;
      let parts = had;
      if (opts.checkpoint !== undefined) {
        const text = opts.checkpoint === null ? '' : Buffer.from(JSON.stringify(opts.checkpoint), 'utf8').toString('base64');
        parts = Math.ceil(text.length / PART_CHARS);
        for (let i = 0; i < parts; i++) await store.set(partKey(run.runId, i), text.slice(i * PART_CHARS, (i + 1) * PART_CHARS), ttl);
      }
      const value = { ...asJson(run), ...(parts ? { parts } : {}) } as unknown as JsonValue;
      const r = await store.set(RUN_KEY(run.runId), value, { ...ttl, ...(opts.ifVersion !== undefined ? { ifVersion: opts.ifVersion } : {}) });
      if (r.ok && parts < had) await dropParts(run.runId, parts, had);
      return r.ok;
    },
    async delete(runId) {
      const found = await read(runId);
      await store.delete(RUN_KEY(runId));
      await dropParts(runId, 0, found?.stored.parts ?? 0);
    },
  };
}

/** A run book in this process (prototype): lost on restart, not shared by replicas; at most `max` runs, oldest dropped first. */
export function memoryRunBook(ttlMs: number, max: number): RunBook {
  const runs = new Map<string, { run: string; checkpoint?: string; version: number; expiresAt: number }>();
  let counter = 0;
  const live = (runId: string) => {
    const e = runs.get(runId);
    if (e && e.expiresAt <= Date.now()) { runs.delete(runId); return undefined; }
    return e;
  };
  return {
    kind: 'memory',
    async get(runId) {
      const e = live(runId);
      return e ? { run: JSON.parse(e.run) as WaitingRun, version: e.version } : undefined;
    },
    async checkpoint(runId) {
      const e = live(runId);
      return e?.checkpoint === undefined ? undefined : JSON.parse(e.checkpoint) as JsonValue;
    },
    async put(run, opts = {}) {
      const e = live(run.runId);
      if (opts.ifVersion !== undefined && (e?.version ?? 0) !== opts.ifVersion) return false;
      const checkpoint = opts.checkpoint === undefined ? e?.checkpoint : opts.checkpoint === null ? undefined : JSON.stringify(opts.checkpoint);
      runs.delete(run.runId);
      runs.set(run.runId, { run: JSON.stringify(run), ...(checkpoint !== undefined ? { checkpoint } : {}), version: ++counter, expiresAt: Date.now() + ttlMs });
      for (const id of runs.keys()) {
        if (runs.size <= max) break;
        runs.delete(id);
      }
      return true;
    },
    async delete(runId) { runs.delete(runId); },
  };
}

/** A JSON copy: what a run book keeps never shares an object with the run, and drops what JSON cannot carry. */
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Who acted, as recorded on an approval or a cancelled run: `kind:id`, or `anonymous`. */
export const callerRef = (caller: Pick<Caller, 'kind' | 'id'> | undefined): string => (caller ? `${caller.kind}:${caller.id}` : ANONYMOUS.id);

/** True when both callers are the same identity (kind and id), or both anonymous. */
export function sameCaller(a: Pick<Caller, 'kind' | 'id'> | undefined, b: Pick<Caller, 'kind' | 'id'> | undefined): boolean {
  return !a || !b ? !a && !b : a.kind === b.kind && a.id === b.id;
}

/** The target of an access question about an approval: the approval, with the risk and agent of the call it is about. */
export function approvalTarget(a: Approval): AccessTarget {
  const t = a.request.question?.target;
  return {
    kind: 'approval', id: a.id, layer: 'identity', risk: t?.risk ?? 'exec', agent: a.request.agent,
    attrs: { status: a.status, ...(t?.id ? { tool: t.id } : {}) },
  };
}

/** The target of an access question about a run: the run, with its agent and, when it waits for a call, that tool. */
export function runTarget(runId: string, agent: string, tool?: string): AccessTarget {
  return { kind: 'run', id: runId, layer: 'harness', risk: 'exec', agent, ...(tool ? { attrs: { tool } } : {}) };
}

/** Why `answer` is not a resume answer, or undefined. */
export function resumeAnswerProblem(answer: unknown): string | undefined {
  if (!isPlainObject(answer)) return 'answer must be an object';
  const has = (k: string) => Object.hasOwn(answer, k);
  if (has('approval') === has('input')) return 'answer must have exactly one of approval and input';
  if (has('approval')) {
    const a = answer.approval;
    if (!isPlainObject(a) || typeof a.id !== 'string' || !a.id || typeof a.approved !== 'boolean') return 'answer.approval must be {id, approved, reason?}';
    if (a.reason !== undefined && typeof a.reason !== 'string') return 'answer.approval.reason must be a string';
    return undefined;
  }
  const input = answer.input;
  if (typeof input === 'string') return input.length ? undefined : 'answer.input must not be empty';
  if (isPlainObject(input) && Array.isArray(input.messages) && input.messages.length) return undefined;
  return 'answer.input must be a string or {messages}';
}

/** A run in flight in this process: what aborts it and who started it. */
export interface InFlight { controller: AbortController; agent: string; caller?: PublicCaller }

export interface RunControlDeps {
  book: RunBook;
  /** Runs in flight in this process, by run id. */
  inflight: Map<string, InFlight>;
  /** Runs being resumed in this process → their kept input; a resumed run that ends without waiting is dropped from the book. */
  resuming: Map<string, RunInput>;
  approval?: ApprovalPort;
  authorization?: AuthorizationPort;
  telemetry: TelemetryPort;
  agent(name: string): Promise<RunnableAgent>;
}

export interface RunControl {
  resume(runId: string, answer: ResumeAnswer, ctx?: Partial<CallContext>): Promise<RunResult>;
  cancel(runId: string, opts?: CancelOptions): Promise<CancelResult>;
  /** Records how a run ended: a waiting run is kept (with its checkpoint), a resumed run that ended otherwise is dropped. */
  settle(ctx: CallContext, input: RunInput, result: RunResult, pending: ApprovalPending | undefined): Promise<void>;
}

/** Resume, cancel and the record of waiting runs, over a run book. */
export function runControl(deps: RunControlDeps): RunControl {
  const { book, inflight, resuming, telemetry } = deps;
  const refuse = (kind: RunRefused['kind'], message: string): never => { throw new RunRefused(kind, message); };

  /** True when the authorization port allows `action` on `target` for `caller`. Fails closed; cancellation propagates. */
  async function allowed(action: Action, target: AccessTarget, caller: Caller | undefined, signal?: AbortSignal): Promise<boolean> {
    if (!deps.authorization) return false;
    try {
      const q: AccessQuestion = { caller: publicCaller(caller) ?? { ...ANONYMOUS, roles: [], scopes: [] }, action, target };
      return (await deps.authorization.evaluate(q, signal ? { signal } : {})).allowed === true;
    } catch (err) {
      if (signal?.aborted) throw err;
      telemetry.event(EVENT.runControlFailed, { [ATTR.layer]: 'identity', [ATTR.error]: errorMessage(err) });
      return false;
    }
  }

  /**
   * Whether a caller other than the one that started the run may act on it: `decide` on the approval it waits for, as
   * for the gateway's approval routes, or on the run itself when it waits for no approval (input, or in flight).
   */
  function mayDecide(rec: WaitingRun, approval: Approval | undefined, caller: Caller | undefined, signal?: AbortSignal): Promise<boolean> {
    return allowed('decide', approval ? approvalTarget(approval) : runTarget(rec.runId, rec.agent, rec.pending?.tool), caller, signal);
  }

  async function decide(rec: WaitingRun, answer: { id: string; approved: boolean; reason?: string }, approval: Approval | undefined, caller: Caller | undefined, signal?: AbortSignal): Promise<void> {
    if (!rec.pending) refuse('invalid', 'the run does not wait for an approval');
    if (answer.id !== rec.pending!.approval) refuse('invalid', 'the run waits for another approval');
    if (!deps.approval || !approval) return refuse('conflict', 'the approval the run waits for is gone');
    const want = answer.approved ? 'approved' : 'denied';
    if (approval.status !== 'pending') {
      if (approval.status !== want) refuse('conflict', `the approval is ${approval.status}`);
      return;
    }
    if (!(await allowed('decide', approvalTarget(approval), caller, signal))) refuse('forbidden', 'not allowed to decide this approval');
    try {
      await deps.approval.decide(approval.id, { approved: answer.approved, by: callerRef(caller), ...(answer.reason !== undefined ? { reason: answer.reason } : {}) });
    } catch (err) {
      const now = await deps.approval.get(approval.id);
      if (now && now.status !== 'pending') {
        if (now.status !== want) refuse('conflict', `the approval is ${now.status}`);
        return;
      }
      throw err;
    }
  }

  return {
    async resume(runId, answer, init = {}) {
      const problem = resumeAnswerProblem(answer);
      if (problem) refuse('invalid', problem);
      const found = await book.get(runId);
      if (!found) return refuse('not_found', 'no waiting run with this id');
      const { run: rec, version } = found;
      if (rec.status === 'cancelled') refuse('conflict', 'the run was cancelled');
      if (rec.status === 'resuming') refuse('conflict', 'the run is being resumed');
      const resumer = init.caller;
      const signal = init.signal;
      const approval = rec.pending && deps.approval ? await deps.approval.get(rec.pending.approval) : undefined;
      // Only the caller that started the run, unless the authorization port lets the resumer decide for others.
      const owner = sameCaller(rec.caller, resumer);
      if (!owner && !(await mayDecide(rec, approval, resumer, signal))) refuse('forbidden', 'not allowed to resume this run');
      if ('approval' in answer && !rec.pending) refuse('invalid', 'the run does not wait for an approval');
      if ('input' in answer && approval?.status === 'pending') refuse('conflict', `the run waits for approval ${approval.id}: decide it first`);

      if (!(await book.put({ ...rec, status: 'resuming' }, { ifVersion: version }))) refuse('conflict', 'the run is being resumed');
      // The run goes on as the identity that started it: the owner's fresh credential, else none.
      const caller: Caller | undefined = rec.caller
        ? { ...rec.caller, ...(owner && resumer?.credential ? { credential: resumer.credential } : {}) } as Caller
        : undefined;
      const { runId: _id, agent: _agent, caller: _caller, sessionId: _session, ...rest } = init;
      const ctx: Partial<CallContext> = { ...rest, runId, ...(caller ? { caller } : {}), ...(rec.sessionId ? { sessionId: rec.sessionId } : {}) };
      resuming.set(runId, rec.input);
      const mode = 'approval' in answer ? 'approval' : 'input';
      try {
        if ('approval' in answer) await decide(rec, answer.approval, approval, resumer, signal);
        const agent = await deps.agent(rec.agent);
        const checkpoint = agent.resume ? await book.checkpoint(runId) : undefined;
        const deterministic = !!agent.resume && checkpoint !== undefined;
        telemetry.event(EVENT.runResumed, { [ATTR.layer]: 'harness', [ATTR.runId]: runId, [ATTR.name]: rec.agent, 'agent.run.resume.mode': mode, 'agent.run.resume.checkpoint': deterministic });
        return deterministic
          ? await agent.resume!(checkpoint, answer, ctx)
          : await agent.run('input' in answer ? answer.input : rec.input, ctx);
      } catch (err) {
        // The run is still waiting (a refused decision, a runtime error): another resume may try again.
        await book.put({ ...rec, status: 'waiting' }).catch(() => {});
        throw err;
      } finally {
        resuming.delete(runId);
      }
    },

    async cancel(runId, opts = {}) {
      const by = opts.by;
      const live = inflight.get(runId);
      if (live) {
        if (!sameCaller(live.caller, by) && !(await allowed('decide', runTarget(runId, live.agent), by, opts.signal))) refuse('forbidden', 'not allowed to cancel this run');
        live.controller.abort(new DOMException(opts.reason ?? 'the run was cancelled', 'AbortError'));
        telemetry.event(EVENT.runCancelled, { [ATTR.layer]: 'harness', [ATTR.runId]: runId, [ATTR.name]: live.agent, 'agent.run.cancel.outcome': 'aborted' });
        return { runId, outcome: 'aborted' };
      }
      const found = await book.get(runId);
      if (!found) return refuse('not_found', 'no run in flight or waiting with this id');
      const { run: rec, version } = found;
      if (rec.status === 'cancelled') refuse('conflict', 'the run was already cancelled');
      if (rec.status === 'resuming') refuse('conflict', 'the run is being resumed');
      const approval = rec.pending && deps.approval ? await deps.approval.get(rec.pending.approval) : undefined;
      if (!sameCaller(rec.caller, by) && !(await mayDecide(rec, approval, by, opts.signal))) refuse('forbidden', 'not allowed to cancel this run');
      const cancelled = { by: callerRef(by), ...(opts.reason !== undefined ? { reason: opts.reason } : {}), at: new Date().toISOString() };
      if (!(await book.put({ ...rec, status: 'cancelled', cancelled }, { ifVersion: version, checkpoint: null }))) refuse('conflict', 'the run changed while being cancelled');
      // Its approval is withdrawn, so nobody decides a call that will not run.
      if (approval?.status === 'pending' && deps.approval?.cancel) {
        await deps.approval!.cancel!(approval.id, { by: cancelled.by, ...(opts.reason !== undefined ? { reason: opts.reason } : {}) }).catch(() => {});
      }
      telemetry.event(EVENT.runCancelled, { [ATTR.layer]: 'harness', [ATTR.runId]: runId, [ATTR.name]: rec.agent, 'agent.run.cancel.outcome': 'cancelled' });
      return { runId, outcome: 'cancelled' };
    },

    async settle(ctx, input, result, pending) {
      const runId = ctx.runId;
      if (result.status !== 'waiting') {
        if (resuming.has(runId)) await book.delete(runId).catch((err: unknown) => keepFailed(runId, err));
        return;
      }
      const approval = result.ext?.['sdk.approval'] as { id?: unknown; by?: unknown; tool?: unknown } | undefined;
      const id = pending?.approval ?? (typeof approval?.id === 'string' ? approval.id : undefined);
      const by = pending?.by ?? (typeof approval?.by === 'string' ? approval.by : undefined);
      const tool = pending?.tool ?? (typeof approval?.tool === 'string' ? approval.tool : undefined);
      const caller = publicCaller(ctx.caller);
      const rec: WaitingRun = {
        runId, agent: ctx.agent, status: 'waiting', input: resuming.get(runId) ?? input,
        ...(caller ? { caller } : {}), ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}), ...(result.reason ? { reason: result.reason } : {}),
        ...(id ? { pending: { approval: id, ...(by ? { by } : {}), ...(tool ? { tool } : {}), ...(pending?.args ? { args: pending.args } : {}) } } : {}),
        at: new Date().toISOString(),
      };
      try {
        await book.put(rec, { checkpoint: result.checkpoint ?? null });
      } catch (err) {
        // A checkpoint the book cannot hold (too large for the store): the run stays resumable by running it again.
        keepFailed(runId, err);
        await book.put(rec, { checkpoint: null }).catch((e: unknown) => keepFailed(runId, e));
      }
    },
  };

  function keepFailed(runId: string, err: unknown): void {
    telemetry.event(EVENT.runKeepFailed, { [ATTR.layer]: 'harness', [ATTR.runId]: runId, [ATTR.error]: errorMessage(err) });
  }
}
