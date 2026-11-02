import { createHmac } from 'node:crypto';
import type { InboundRoute } from './ports/channel.ts';
import type { AnonymousCaller, Caller } from './ports/identity.ts';
import { sha256 } from './util.ts';

/** A session id a client may send: letters, digits, `_`, `.`, `:` and `-`, 1 to 128 characters. */
export const INBOUND_SESSION_ID = /^[\w.:-]{1,128}$/;

/**
 * Digest of a session owner (`<kind>:<id>`) inside session ids, 16 hex characters. Session ids leave the process (an
 * A2A runtime sends them as the context id), so the stack keys it with `sessions.secret`.
 */
export type OwnerDigest = (owner: string) => string;

/** The owner digest: HMAC-SHA-256 keyed with `secret`, plain SHA-256 without one (guessable from the caller id). */
export function ownerDigest(secret?: string): OwnerDigest {
  if (secret) return (owner) => createHmac('sha256', secret).update(owner).digest('hex').slice(0, 16);
  return (owner) => sha256(owner).slice(0, 16);
}

/**
 * The session id of an inbound request: the client's value scoped to its caller (`<channel>-<owner digest>-<value>`),
 * so the same value sent by another caller is another session. Undefined when the value is missing or malformed, and
 * when no caller was verified: anonymous clients could otherwise join each other's sessions (and approvals) by
 * sending the same value. Pass the host's `ownerDigest`, keyed with the stack's `sessions.secret`.
 */
export function inboundSessionId(channel: string, caller: Pick<Caller | AnonymousCaller, 'kind' | 'id'> | undefined, value: unknown, digest: OwnerDigest = ownerDigest()): string | undefined {
  if (!caller || caller.kind === 'anonymous' || typeof value !== 'string' || !INBOUND_SESSION_ID.test(value)) return undefined;
  return `${channel}-${digest(`${caller.kind}:${caller.id}`)}-${value}`;
}

/** True when `path` matches the route path: exact, or a prefix for a route path ending in `/*`. */
export function routeMatches(route: Pick<InboundRoute, 'path'>, path: string): boolean {
  if (!route.path.endsWith('/*')) return route.path === path;
  const prefix = route.path.slice(0, -2);
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The route for a request: the most specific path that matches (exact before prefix, longer before shorter).
 * `allowed` lists the methods of matching routes, for a 405 answer when none accepts the method.
 */
export function findRoute<R extends Pick<InboundRoute, 'path' | 'methods'>>(routes: readonly R[], method: string, path: string): { route?: R; allowed: string[] } {
  const matching = routes.filter((r) => routeMatches(r, path))
    .sort((a, b) => Number(a.path.endsWith('/*')) - Number(b.path.endsWith('/*')) || b.path.length - a.path.length);
  const route = matching.find((r) => !r.methods || r.methods.includes(method.toUpperCase()));
  return { ...(route ? { route } : {}), allowed: [...new Set(matching.flatMap((r) => r.methods ?? []))] };
}
