import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  configuredAdapters, ConfigError, findRoute, InboundRejected, readiness,
  type ChannelPort, type GatewayConfig, type Identity, type InboundContext, type InboundRoute, type Stack, type TelemetryPort,
  type TriggerPort, type TriggerSink,
} from '@agent-layers/core';
import { BodyTooLarge, errorResponse, readBody, toRequest, writeResponse } from './http.ts';

export { BodyTooLarge, errorResponse } from './http.ts';

/** A channel or trigger instance of the stack that the gateway mounts. Instances listed in `stack.ports.triggers` are triggers. */
export type InboundAdapterInstance = ChannelPort | TriggerPort;

export interface GatewayOptions extends Omit<GatewayConfig, 'inbound'> {
  /** What to mount; default: every mountable channel and trigger of the stack, or those named in `stack.config.gateway.inbound`. */
  inbound?: InboundAdapterInstance[];
  /** How long `close` waits for requests and trigger runs in flight (default 10000 ms). */
  closeGraceMs?: number;
}

export interface GatewayHandle {
  /** Base URL the gateway listens on. */
  url: string;
  port: number;
  /** Mounted routes, as `METHOD path (instance)`, for start-up logs. */
  routes: string[];
  /** Stops accepting requests, waits for those in flight and for trigger runs, then releases the mounts. */
  close(): Promise<void>;
}

const DEFAULTS = { port: 8787, host: '127.0.0.1', maxBodyBytes: 1024 * 1024, requestTimeoutMs: 300_000, closeGraceMs: 10_000 } as const;
const RESERVED = ['/healthz', '/readyz'];
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
const REALM = 'agent-layers';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

interface Mounted { route: InboundRoute; instance: string }

const untilAborted = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

/** The channel and trigger instances of a stack, named as in its config, that can be mounted on a host server. */
export function mountableInbound(stack: Stack, names?: readonly string[]): { name: string; port: InboundAdapterInstance }[] {
  const all: { name: string; port: InboundAdapterInstance }[] = [];
  const index = { channels: 0, triggers: 0 };
  for (const e of configuredAdapters(stack.config.layers)) {
    if (e.slot !== 'channels' && e.slot !== 'triggers') continue;
    const port = (stack.ports[e.slot] as InboundAdapterInstance[])[index[e.slot]++];
    if (port) all.push({ name: e.key, port });
  }
  if (!names) return all.filter((x) => typeof x.port.mount === 'function');
  return names.map((n) => {
    const found = all.find((x) => x.name === n);
    if (!found) throw new ConfigError([`gateway.inbound: "${n}" is not a configured channel or trigger (known: ${all.map((x) => x.name).join(', ') || 'none'})`]);
    if (typeof found.port.mount !== 'function') throw new ConfigError([`gateway.inbound: "${n}" cannot be mounted on the gateway (it has no mount())`]);
    return found;
  });
}

/**
 * Hosts a composed stack on the network: mounts its inbound adapters on one node:http server, authenticates every
 * request through the identity port, enforces body and time limits, logs each request through the telemetry port
 * (layer `interface`) and serves `/healthz` and `/readyz`. Closing the gateway does not close the stack.
 */
export async function serveStack(stack: Stack, opts: GatewayOptions = {}): Promise<GatewayHandle> {
  const tier = stack.config.tier;
  // Anonymous callers only when the config says so; never on the production tier.
  const anonymous = opts.anonymous === true;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULTS.maxBodyBytes;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
  const telemetry: TelemetryPort = stack.telemetry;
  if (tier === 'production' && anonymous) throw new ConfigError(['gateway: anonymous requests are not allowed on the production tier (remove gateway.anonymous)']);
  if (tier === 'production' && !stack.ports.identity) throw new ConfigError(['gateway: the production tier needs an identity adapter (layers.identity) to authenticate requests']);
  if (!stack.ports.identity && !anonymous) {
    throw new ConfigError(['gateway: no identity adapter is configured and gateway.anonymous is not true, so every request would be refused']);
  }

  const selected = opts.inbound
    ? opts.inbound.map((port, i) => ({ name: port.name ?? `inbound-${i}`, port }))
    : mountableInbound(stack, stack.config.gateway.inbound);
  const triggers = new Set<unknown>(stack.ports.triggers);

  let draining = false;
  const inflight = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    p.finally(() => inflight.delete(p)).catch(() => {});
    return p;
  };

  const host = stack.host();
  const sink: TriggerSink = {
    agents: () => stack.agents(),
    ...(stack.ports.identity ? { verify: (c: string) => stack.verify(c) } : {}),
    async accept(trigger, ctx = {}) {
      const agent = trigger.agent ?? stack.agents()[0];
      if (!agent || !stack.agents().includes(agent)) throw new InboundRejected('not_found', `unknown agent "${trigger.agent ?? ''}"`);
      if (!ctx.identity && !anonymous) throw new InboundRejected('unauthenticated', 'a trigger run needs an identity');
      if (draining) throw new InboundRejected('forbidden', 'the gateway is shutting down');
      const input = typeof trigger.data === 'string' ? trigger.data : JSON.stringify(trigger.data ?? {});
      const attrs = { 'agent.layer': 'interface' as const, 'trigger.type': trigger.type, 'run.id': trigger.id, 'gen_ai.agent.name': agent };
      track(host.run(agent, input, { runId: trigger.id, ...(ctx.identity ? { identity: ctx.identity } : {}) })
        .then((r) => telemetry.event('gateway.trigger.done', { ...attrs, 'run.status': String(r.status) }))
        .catch(() => telemetry.event('gateway.trigger.done', { ...attrs, 'run.status': 'failed' })));
      return { runId: trigger.id };
    },
  };

  const mounted: Mounted[] = [];
  const closers: (() => Promise<void>)[] = [];
  try {
    for (const { name, port } of selected) {
      if (typeof port.mount !== 'function') throw new ConfigError([`gateway: inbound "${name}" cannot be mounted (it has no mount())`]);
      const mount = triggers.has(port) ? await (port as TriggerPort).mount!(sink) : await (port as ChannelPort).mount!(host);
      if (mount.close) closers.push(() => mount.close!());
      for (const route of mount.routes) {
        if (RESERVED.includes(route.path)) throw new ConfigError([`gateway: inbound "${name}" uses the reserved path ${route.path}`]);
        const clash = mounted.find((m) => m.route.path === route.path && (!m.route.methods || !route.methods || m.route.methods.some((x) => route.methods!.includes(x))));
        if (clash) throw new ConfigError([`gateway: ${route.path} is mounted by both "${clash.instance}" and "${name}"`]);
        mounted.push({ route, instance: name });
      }
    }
  } catch (err) {
    await Promise.allSettled(closers.map((c) => c()));
    throw err;
  }

  const ready = await readiness(stack.config, stack.registry);
  const ownOrigins = new Set<string>();
  const extraOrigins = new Set([...(opts.allowedOrigins ?? []), ...(opts.cors?.origins ?? [])]);
  let allowedHosts: Set<string> | undefined;
  const routes = mounted.map((m) => m.route);
  let origin = '';

  async function authenticate(req: IncomingMessage): Promise<{ identity?: Identity } | Response> {
    const header = req.headers.authorization;
    if (!header) {
      if (anonymous) return {};
      return errorResponse(401, 'authentication required', 'authentication_error', { 'www-authenticate': `Bearer realm="${REALM}"` });
    }
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
    const invalid = () => errorResponse(401, 'invalid credential', 'authentication_error', { 'www-authenticate': `Bearer realm="${REALM}", error="invalid_token"` });
    if (!m || !stack.ports.identity) return invalid();
    try {
      return { identity: await stack.verify(m[1]!) };
    } catch {
      // The identity adapter's message can name the credential or its issuer: the client learns only that it failed.
      return invalid();
    }
  }

  function cors(req: IncomingMessage): Record<string, string> {
    const allowed = opts.cors?.origins;
    const from = req.headers.origin;
    if (!allowed || !from || !(allowed.includes('*') || allowed.includes(from))) return {};
    return { 'access-control-allow-origin': from, vary: 'Origin', 'access-control-expose-headers': 'mcp-session-id, x-request-id' };
  }

  /**
   * DNS rebinding and cross-site requests: a request that carries an `Origin` must come from the gateway's own origin,
   * an allowed origin or a CORS origin; when bound to loopback (or with `allowedHosts`), the `Host` must be a known name.
   */
  function checkOriginAndHost(req: IncomingMessage): Response | undefined {
    const from = req.headers.origin;
    if (from !== undefined && !ownOrigins.has(from) && !extraOrigins.has(from) && !extraOrigins.has('*')) {
      return errorResponse(403, 'origin not allowed', 'permission_error');
    }
    if (allowedHosts) {
      const hostHeader = String(req.headers.host ?? '').toLowerCase();
      const name = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.replace(/:\d+$/, '');
      if (!allowedHosts.has(hostHeader) && !allowedHosts.has(name)) return errorResponse(403, 'host not allowed', 'permission_error');
    }
    return undefined;
  }

  async function exchange(req: IncomingMessage, requestId: string, signal: AbortSignal, attrs: Record<string, string | number | boolean>): Promise<Response> {
    const path = new URL(req.url ?? '/', 'http://gateway').pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    const corsHeaders = cors(req);
    const preflightRefused = method === 'OPTIONS' ? checkOriginAndHost(req) : undefined;
    if (preflightRefused) return preflightRefused;
    if (method === 'OPTIONS' && req.headers['access-control-request-method'] && Object.keys(corsHeaders).length) {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': String(req.headers['access-control-request-headers'] ?? 'authorization, content-type'),
          'access-control-max-age': '600',
        },
      });
    }
    if (path === '/healthz') return Response.json({ status: 'ok' });
    if (path === '/readyz') {
      const ok = ready.ok && !draining;
      return Response.json({ status: draining ? 'draining' : ok ? 'ready' : 'not-ready', tier, problems: ready.problems.length }, { status: ok ? 200 : 503 });
    }
    const refused = checkOriginAndHost(req);
    if (refused) return refused;
    const { route, allowed } = findRoute(routes, method, path);
    if (!route) {
      return allowed.length
        ? errorResponse(405, `method ${method} not allowed`, 'invalid_request_error', { allow: allowed.join(', ') })
        : errorResponse(404, `no route for ${path}`, 'not_found_error');
    }
    const entry = mounted.find((m) => m.route === route)!;
    attrs['http.route'] = route.path;
    attrs['gateway.inbound'] = entry.instance;
    let identity: Identity | undefined;
    if (!route.public) {
      const auth = await authenticate(req);
      if (auth instanceof Response) return auth;
      identity = auth.identity;
    }
    attrs['gateway.authenticated'] = !!identity;
    let body: Buffer | undefined;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLarge) return errorResponse(413, `request body larger than ${maxBodyBytes} bytes`, 'invalid_request_error', { connection: 'close' });
      throw err;
    }
    const ctx: InboundContext = { requestId, signal, origin, ...(identity ? { identity } : {}) };
    // A route that does not answer within the time limit (or before the client leaves) loses the exchange.
    const lost = untilAborted(signal);
    return Promise.race([lost, route.handle(toRequest(req, origin, body, signal), ctx)]);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const given = req.headers['x-request-id'];
    const requestId = typeof given === 'string' && REQUEST_ID.test(given) ? given : randomUUID();
    const client = new AbortController();
    res.once('close', () => { if (!res.writableFinished) client.abort(); });
    const signal = AbortSignal.any([client.signal, AbortSignal.timeout(requestTimeoutMs)]);
    const started = Date.now();
    // The path only: query strings can carry credentials.
    const attrs: Record<string, string | number | boolean> = {
      'http.request.method': req.method ?? 'GET', 'url.path': new URL(req.url ?? '/', 'http://gateway').pathname, 'gateway.request_id': requestId,
    };
    await telemetry.span('gateway.request', { 'agent.layer': 'interface', ...attrs }, async (span) => {
      let response: Response;
      if (draining) response = errorResponse(503, 'the gateway is shutting down', 'unavailable', { connection: 'close' });
      else {
        try {
          response = await exchange(req, requestId, signal, attrs);
        } catch {
          // Never the error text: it can carry upstream bodies or credentials.
          response = signal.aborted && !client.signal.aborted
            ? errorResponse(504, 'request timed out', 'timeout_error')
            : errorResponse(500, 'internal error', 'server_error');
        }
      }
      await writeResponse(res, response, { 'x-request-id': requestId, ...cors(req) });
      span.setAttributes({ ...attrs, 'http.response.status_code': response.status, 'gateway.duration_ms': Date.now() - started });
      telemetry.metric('gateway.requests', 1, { 'agent.layer': 'interface', 'http.response.status_code': response.status, ...(attrs['gateway.inbound'] ? { 'gateway.inbound': String(attrs['gateway.inbound']) } : {}) });
    }).catch(() => { if (!res.headersSent) { res.writeHead(500); } if (!res.writableEnded) res.end(); });
  }

  const server = createServer((req, res) => { track(handle(req, res)); });
  server.headersTimeout = 30_000;
  server.requestTimeout = Math.min(requestTimeoutMs, 120_000);
  const hostName = opts.host ?? DEFAULTS.host;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULTS.port, hostName, () => { server.off('error', reject); resolve(); });
  }).catch(async (err: unknown) => {
    await Promise.allSettled(closers.map((c) => c()));
    throw err;
  });
  const port = (server.address() as AddressInfo).port;
  const shown = hostName === '0.0.0.0' || hostName === '::' ? 'localhost' : hostName.includes(':') ? `[${hostName}]` : hostName;
  const url = `http://${shown}:${port}`;
  origin = (opts.publicOrigin ?? url).replace(/\/+$/, '');
  const loopback = LOOPBACK.includes(hostName.toLowerCase());
  ownOrigins.add(origin);
  ownOrigins.add(url);
  if (loopback) for (const n of ['localhost', '127.0.0.1', '[::1]']) ownOrigins.add(`http://${n}:${port}`);
  const publicHost = opts.publicOrigin ? new URL(origin).host.toLowerCase() : undefined;
  allowedHosts = opts.allowedHosts
    ? new Set([...opts.allowedHosts.map((h) => h.toLowerCase()), ...(publicHost ? [publicHost] : [])])
    : loopback ? new Set(['localhost', '127.0.0.1', '[::1]', ...(publicHost ? [publicHost] : [])]) : undefined;

  let closing: Promise<void> | undefined;
  return {
    url,
    port,
    routes: mounted.map((m) => `${m.route.methods?.join('|') ?? '*'} ${m.route.path} (${m.instance})`),
    close() {
      closing ??= (async () => {
        draining = true;
        const stopped = new Promise<void>((r) => server.close(() => r()));
        server.closeIdleConnections();
        const grace = new Promise<void>((r) => setTimeout(r, opts.closeGraceMs ?? DEFAULTS.closeGraceMs).unref());
        await Promise.race([Promise.allSettled([...inflight]), grace]);
        server.closeAllConnections();
        await stopped;
        await Promise.allSettled(closers.map((c) => c()));
      })();
      return closing;
    },
  };
}
