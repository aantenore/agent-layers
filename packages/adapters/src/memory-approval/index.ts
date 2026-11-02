import { randomUUID } from 'node:crypto';
import { defineAdapter, limitProperties, limitValue, PORT_VERSIONS, type Approval, type ApprovalPort, type ApprovalRequest, type ApprovalStatus, type LimitValue } from '@agent-layers/core';
import { LIMITS } from './limits.ts';

export interface MemoryApprovalOptions {
  /** Time a pending approval stays open before it reports `expired`. Open indefinitely when unset or `"unbounded"`. */
  ttlMs?: LimitValue;
  /** Most approvals one `list` returns, and its default (default 100). */
  listLimit?: number;
}

interface Entry { approval: Approval; expiresAt: number | undefined; listeners: Set<() => void>; consumed: boolean }

/** A copy of the request whose caller never carries a credential, even when one slips in: approvals are shown to people. */
function stored(req: ApprovalRequest): ApprovalRequest {
  const request = structuredClone(req);
  const caller = request.question?.caller as { credential?: unknown } | undefined;
  if (caller && typeof caller === 'object') delete caller.credential;
  return request;
}

/** Approval store kept in memory; `wait` is driven by listeners, not polling. `lookup` finds approvals by request key. */
export function createMemoryApproval(options: MemoryApprovalOptions = {}, name = 'memory-approval'): ApprovalPort {
  const entries = new Map<string, Entry>();
  /** Approval ids per request key, oldest first. */
  const byKey = new Map<string, string[]>();
  const ttlMs = limitValue(LIMITS.ttlMs, options.ttlMs);
  const listLimit = limitValue(LIMITS.listLimit, options.listLimit);

  const view = (e: Entry): Approval =>
    structuredClone(e.approval.status === 'pending' && e.expiresAt !== undefined && e.expiresAt <= Date.now()
      ? { ...e.approval, status: 'expired' as const }
      : e.approval);
  const find = (id: string): Entry => {
    const entry = entries.get(id);
    if (!entry) throw new Error(`unknown approval ${id}`);
    return entry;
  };
  /** Ends a pending approval (decided or cancelled) and wakes its waiters. */
  const settle = (id: string, status: Exclude<ApprovalStatus, 'pending' | 'expired'>, by: { by?: string; reason?: string }): Approval => {
    const entry = find(id);
    const current = view(entry);
    if (current.status !== 'pending') throw new Error(`approval ${id} is already ${current.status}`);
    entry.approval = {
      ...entry.approval,
      status,
      ...(by.by !== undefined ? { decidedBy: by.by } : {}),
      ...(by.reason !== undefined ? { reason: by.reason } : {}),
    };
    for (const notify of [...entry.listeners]) notify();
    return view(entry);
  };

  return {
    name,
    native: () => entries,
    async request(req) {
      // A pending, unexpired request for the same key is the one a person will decide: reuse it, so `lookup` finds it.
      // Checked and recorded in one synchronous step, so concurrent requests cannot both create one.
      for (const id of [...(req.key ? byKey.get(req.key) ?? [] : [])].reverse()) {
        const entry = entries.get(id);
        if (entry && !entry.consumed && view(entry).status === 'pending') return view(entry);
      }
      const expiresAt = req.expiresAt ? Date.parse(req.expiresAt) : Number.isFinite(ttlMs) ? Date.now() + ttlMs : undefined;
      const request = stored(req);
      if (expiresAt !== undefined && !request.expiresAt) request.expiresAt = new Date(expiresAt).toISOString();
      const entry: Entry = { approval: { id: randomUUID(), status: 'pending', request }, expiresAt, listeners: new Set(), consumed: false };
      entries.set(entry.approval.id, entry);
      if (request.key) byKey.set(request.key, [...(byKey.get(request.key) ?? []), entry.approval.id]);
      return view(entry);
    },
    async lookup(key, opts = {}) {
      const ids = byKey.get(key) ?? [];
      for (let i = ids.length - 1; i >= 0; i--) {
        const entry = entries.get(ids[i]!);
        if (!entry || entry.consumed) continue;
        const current = view(entry);
        if (opts.consume && current.status === 'approved') entry.consumed = true;
        return current;
      }
      return undefined;
    },
    async get(id) {
      const entry = entries.get(id);
      return entry && view(entry);
    },
    async decide(id, decision) {
      return settle(id, decision.approved ? 'approved' : 'denied', decision);
    },
    async cancel(id, opts = {}) {
      return settle(id, 'cancelled', opts);
    },
    async list(opts = {}) {
      const status = opts.status ?? 'pending';
      const limit = Math.min(listLimit, Math.max(0, Math.trunc(opts.limit ?? listLimit)));
      const out: Approval[] = [];
      // Map order is insertion order: oldest first.
      for (const entry of entries.values()) {
        if (out.length >= limit) break;
        const current = view(entry);
        if (current.status === status) out.push(current);
      }
      return out;
    },
    wait(id, opts = {}) {
      return new Promise<Approval>((resolve, reject) => {
        const entry = entries.get(id);
        if (!entry) return reject(new Error(`unknown approval ${id}`));
        if (view(entry).status !== 'pending') return resolve(view(entry));
        if (opts.signal?.aborted) return reject(opts.signal.reason);

        const timers: NodeJS.Timeout[] = [];
        const finish = () => {
          timers.forEach(clearTimeout);
          entry.listeners.delete(done);
          opts.signal?.removeEventListener('abort', abort);
        };
        const done = () => { finish(); resolve(view(entry)); };
        const abort = () => { finish(); reject(opts.signal?.reason); };

        entry.listeners.add(done);
        opts.signal?.addEventListener('abort', abort, { once: true });
        if (opts.timeoutMs !== undefined) timers.push(setTimeout(done, opts.timeoutMs));
        // A timer may fire just before the clock reaches the expiry: re-arm until the approval reads expired.
        const expire = () => {
          const left = entry.expiresAt! - Date.now();
          if (left > 0) timers.push(setTimeout(expire, left));
          else done();
        };
        if (entry.expiresAt !== undefined) timers.push(setTimeout(expire, Math.max(0, entry.expiresAt - Date.now())));
      });
    },
    async close() {
      for (const entry of entries.values()) for (const notify of [...entry.listeners]) notify();
      entries.clear();
      byKey.clear();
    },
  };
}

export const adapter = defineAdapter<'ApprovalPort', MemoryApprovalOptions>({
  layer: 'identity',
  port: 'ApprovalPort',
  name: 'memory-approval',
  direction: 'outbound',
  maps: { technology: 'in-process store' },
  portVersion: PORT_VERSIONS.ApprovalPort,
  tiers: ['prototype'],
  description: 'Keeps approvals in memory and wakes waiters when one is decided. Lost on restart; for development and demos.',
  optionsSchema: {
    type: 'object',
    properties: limitProperties(LIMITS, {
      ttlMs: 'Time a pending approval stays open before it expires',
      listLimit: 'Most approvals one list returns, and its default',
    }),
    additionalProperties: false,
  },
  limits: LIMITS,
  ext: { produces: [] },
  create: (options, ctx) => createMemoryApproval(options, ctx.name),
});

export const adapters = [adapter];
