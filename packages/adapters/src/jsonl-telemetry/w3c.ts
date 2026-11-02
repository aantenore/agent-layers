import type { TraceCodec, TraceContext, TraceIdSet } from '@agent-layers/core';

// W3C Trace Context. Version 00 has exactly four fields; later versions may append more after a dash.
const V00 = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const FUTURE = /^(?!00-|ff-)[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;
const ZERO = /^0+$/;

const MAX_STATE_CHARS = 512;
const MAX_STATE_MEMBERS = 32;
const SIMPLE_KEY = /^[a-z][a-z0-9_*/-]{0,255}$/;
const TENANT_KEY = /^[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13}$/;
const VALUE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;

/** The tracestate as received when it is a valid list, else undefined (a malformed one is dropped, not repaired). */
function validState(state: string | undefined): string | undefined {
  if (!state || state.length > MAX_STATE_CHARS) return undefined;
  const members = state.split(/[ \t]*,[ \t]*/).map((m) => m.trim()).filter(Boolean);
  if (!members.length || members.length > MAX_STATE_MEMBERS) return undefined;
  const keys = new Set<string>();
  for (const member of members) {
    const eq = member.indexOf('=');
    const key = member.slice(0, eq);
    if (eq < 1 || !(SIMPLE_KEY.test(key) || TENANT_KEY.test(key)) || !VALUE.test(member.slice(eq + 1)) || keys.has(key)) return undefined;
    keys.add(key);
  }
  return state.trim();
}

/** `traceparent` (`parent`) and `tracestate` (`state`) of W3C Trace Context. An invalid parent yields no ids. */
export const w3cCodec: TraceCodec = {
  parse(trace: TraceContext): TraceIdSet | undefined {
    const m = typeof trace?.parent === 'string' ? (V00.exec(trace.parent) ?? FUTURE.exec(trace.parent)) : null;
    if (!m || ZERO.test(m[1]!) || ZERO.test(m[2]!)) return undefined;
    const state = validState(typeof trace.state === 'string' ? trace.state : undefined);
    return { traceId: m[1]!, spanId: m[2]!, flags: m[3]!, ...(state ? { state } : {}) };
  },
  format: (ids: TraceIdSet): TraceContext => ({ parent: `00-${ids.traceId}-${ids.spanId}-${ids.flags ?? '01'}`, ...(ids.state ? { state: ids.state } : {}) }),
};
