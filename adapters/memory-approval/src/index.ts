import { randomUUID } from 'node:crypto';
import { defineAdapter, PORT_VERSIONS, type Approval, type ApprovalPort } from '@agent-layers/core';

export interface MemoryApprovalOptions {
  /** Time a pending approval stays open before it reports `expired`. Open indefinitely when unset. */
  ttlMs?: number;
}

interface Entry { approval: Approval; expiresAt: number | undefined; listeners: Set<() => void> }

/** Approval store kept in memory; `wait` is driven by listeners, not polling. */
export function createMemoryApproval(options: MemoryApprovalOptions = {}, name = 'memory-approval'): ApprovalPort {
  const entries = new Map<string, Entry>();

  const view = (e: Entry): Approval =>
    structuredClone(e.approval.status === 'pending' && e.expiresAt !== undefined && e.expiresAt <= Date.now()
      ? { ...e.approval, status: 'expired' as const }
      : e.approval);
  const find = (id: string): Entry => {
    const entry = entries.get(id);
    if (!entry) throw new Error(`unknown approval ${id}`);
    return entry;
  };

  return {
    name,
    native: () => entries,
    async request(req) {
      const expiresAt = req.expiresAt ? Date.parse(req.expiresAt) : options.ttlMs === undefined ? undefined : Date.now() + options.ttlMs;
      const request = structuredClone(req);
      if (expiresAt !== undefined && !request.expiresAt) request.expiresAt = new Date(expiresAt).toISOString();
      const entry: Entry = { approval: { id: randomUUID(), status: 'pending', request }, expiresAt, listeners: new Set() };
      entries.set(entry.approval.id, entry);
      return view(entry);
    },
    async get(id) {
      const entry = entries.get(id);
      return entry && view(entry);
    },
    async decide(id, decision) {
      const entry = find(id);
      const current = view(entry);
      if (current.status !== 'pending') throw new Error(`approval ${id} is already ${current.status}`);
      entry.approval = {
        ...entry.approval,
        status: decision.approved ? 'approved' : 'denied',
        ...(decision.by !== undefined ? { decidedBy: decision.by } : {}),
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      };
      for (const notify of [...entry.listeners]) notify();
      return view(entry);
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
        if (entry.expiresAt !== undefined) timers.push(setTimeout(done, Math.max(0, entry.expiresAt - Date.now())));
      });
    },
    async close() {
      for (const entry of entries.values()) for (const notify of [...entry.listeners]) notify();
      entries.clear();
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
    properties: { ttlMs: { type: 'integer', minimum: 1 } },
    additionalProperties: false,
  },
  create: (options, ctx) => createMemoryApproval(options, ctx.name),
});

export const adapters = [adapter];
