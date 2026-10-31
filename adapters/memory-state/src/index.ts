import { defineAdapter, PORT_VERSIONS, type RunEvent, type StatePort } from '@agent-layers/core';

/** Session event log kept in a Map. Events are copied on the way in and out. */
export function createMemoryState(name = 'memory-state'): StatePort {
  const sessions = new Map<string, RunEvent[]>();
  return {
    name,
    native: () => sessions,
    async append(sessionId, events) {
      const log = sessions.get(sessionId) ?? [];
      // Re-insert so the Map order is "least recently appended first".
      sessions.delete(sessionId);
      sessions.set(sessionId, [...log, ...structuredClone(events)]);
    },
    async read(sessionId) {
      return structuredClone(sessions.get(sessionId) ?? []);
    },
    async list(opts) {
      const ids = [...sessions.keys()].reverse();
      return opts?.limit === undefined ? ids : ids.slice(0, Math.max(0, opts.limit));
    },
    async delete(sessionId) {
      sessions.delete(sessionId);
    },
    async close() {
      sessions.clear();
    },
  };
}

export const adapter = defineAdapter<'StatePort', Record<string, never>>({
  layer: 'harness',
  port: 'StatePort',
  name: 'memory-state',
  direction: 'outbound',
  maps: { technology: 'in-process Map' },
  portVersion: PORT_VERSIONS.StatePort,
  tiers: ['prototype'],
  description: 'Keeps session event logs in memory. Lost on restart; for development and demos.',
  optionsSchema: { type: 'object', properties: {}, additionalProperties: false },
  create: (_options, ctx) => createMemoryState(ctx.name),
});

export const adapters = [adapter];
