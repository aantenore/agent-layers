import { defineAdapter, defineLimits, limitProperties, limitValue, PORT_VERSIONS, type LimitValue, type RunEvent, type StatePort } from '@agent-layers/core';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface MemoryStateOptions {
  /** Sessions kept; a new session beyond this evicts the least recently appended one (default 1000). */
  maxSessions?: LimitValue;
  /** Events kept per session; older events are dropped, the most recent are kept (default 10000). */
  maxEventsPerSession?: LimitValue;
}

/** Configurable limits; see docs/limits.md. */
export const LIMITS = defineLimits({
  maxSessions: { path: 'options.maxSessions', default: 1000, unit: 'count', min: 1, unbounded: 'warn', safe: { max: 100_000 } },
  maxEventsPerSession: { path: 'options.maxEventsPerSession', default: 10_000, unit: 'count', min: 1, unbounded: 'warn', safe: { max: 1_000_000 } },
});

/**
 * Session event log kept in a Map. Events are copied on the way in and out. Memory is bounded: the least recently
 * appended session is evicted past `maxSessions`, and a session keeps only its most recent `maxEventsPerSession`.
 */
export function createMemoryState(options: MemoryStateOptions = {}, name = 'memory-state'): StatePort {
  const maxSessions = limitValue(LIMITS.maxSessions, options.maxSessions);
  const maxEvents = limitValue(LIMITS.maxEventsPerSession, options.maxEventsPerSession);
  const sessions = new Map<string, RunEvent[]>();
  return {
    name,
    native: () => sessions,
    async append(sessionId, events) {
      const log = [...(sessions.get(sessionId) ?? []), ...structuredClone(events)];
      // Re-insert so the Map order is "least recently appended first".
      sessions.delete(sessionId);
      sessions.set(sessionId, log.length > maxEvents ? log.slice(log.length - maxEvents) : log);
      for (const id of sessions.keys()) {
        if (sessions.size <= maxSessions) break;
        sessions.delete(id);
      }
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

export const adapter = defineAdapter<'StatePort', MemoryStateOptions>({
  layer: 'harness',
  port: 'StatePort',
  name: 'memory-state',
  direction: 'outbound',
  maps: { technology: 'in-process Map' },
  portVersion: PORT_VERSIONS.StatePort,
  tiers: ['prototype'],
  description: 'Keeps session event logs in memory, bounded by session and per-session event caps. Lost on restart; for development and demos.',
  optionsSchema: {
    type: 'object',
    properties: {
      ...limitProperties(LIMITS, {
        maxSessions: 'Sessions kept; a new session beyond this evicts the least recently appended one',
        maxEventsPerSession: 'Events kept per session; older events are dropped and the most recent are kept',
      }),
    },
    additionalProperties: false,
  },
  limits: LIMITS,
  create: (options, ctx) => createMemoryState(options, ctx.name),
});

export const adapters = [adapter];
