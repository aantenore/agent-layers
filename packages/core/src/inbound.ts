import type { InboundRoute } from './ports/channel.ts';

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
