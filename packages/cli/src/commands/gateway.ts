import { compose, readiness } from '@agent-layers/core';
import { serveStack } from '@agent-layers/gateway';
import { UsageError, type Io } from '../io.ts';
import { openProject } from '../project.ts';
import { traceTelemetry } from '../trace.ts';

export interface GatewayArgs { config?: string; profile?: string; port?: string; host?: string }

/** Resolves on SIGINT or SIGTERM. */
export const untilSignal = (): Promise<void> => new Promise((resolve) => {
  const done = () => { process.off('SIGINT', done); process.off('SIGTERM', done); resolve(); };
  process.once('SIGINT', done);
  process.once('SIGTERM', done);
});

/**
 * Composes the stack of a profile and hosts it on the network: the mountable channels and triggers on one address,
 * every request authenticated through the identity slot. A production-tier profile must pass the readiness gate.
 */
export async function gateway(io: Io, args: GatewayArgs, wait: () => Promise<void> = untilSignal): Promise<number> {
  const p = await openProject(io, args);
  const ready = await readiness(p.config, p.registry);
  const missing = ready.problems.filter((x) => x.kind === 'not-installed' || x.kind === 'load-failed');
  if (missing.length) throw new UsageError(missing.map((m) => m.message).join('\n'));
  if (p.config.tier === 'production' && !ready.ok) throw new UsageError(`profile ${p.config.profile ?? '(base)'} fails the readiness gate:\n${[...ready.problems.map((x) => x.message), ...ready.limits.filter((l) => l.severity === 'fail').map((l) => `limit ${l.message}`)].map((m) => `  ${m}`).join('\n')}`);
  const port = args.port !== undefined ? Number(args.port) : p.config.gateway.port;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new UsageError(`--port must be an integer from 0 to 65535`);
  const trace = !(p.config.layers.telemetry as unknown[] | undefined)?.length;
  const stack = await compose(p.config, { registry: p.registry, env: p.env, ...(trace ? { telemetry: [traceTelemetry(io.err)] } : {}) });
  try {
    const { inbound: _names, ...options } = p.config.gateway;
    const gw = await serveStack(stack, { ...options, ...(port !== undefined ? { port } : {}), ...(args.host ? { host: args.host } : {}) })
      .catch((err: unknown) => { throw listenError(err) ?? err; });
    io.err(`gateway ${gw.url} · profile ${p.config.profile ?? '(base)'} · tier ${p.config.tier}`);
    for (const r of gw.routes) io.err(`  ${r}`);
    for (const w of gw.warnings) io.err(`  warning: ${w}`);
    if (!gw.routes.length) io.err('  no mountable channels or triggers: only /healthz and /readyz are served');
    await wait();
    io.err('gateway stopping…');
    await gw.close();
    return 0;
  } finally {
    await stack.close();
  }
}

const LISTEN_HINTS: Record<string, string> = {
  EADDRINUSE: 'address already in use; pick another port with --port <n> or gateway.port in agent-layers.json',
  EACCES: 'permission denied; pick a port above 1023 with --port <n> or gateway.port in agent-layers.json',
  EADDRNOTAVAIL: 'address not available on this machine; pick another host with --host <name> or gateway.host in agent-layers.json',
};

/** A failed bind as one line naming the address and the fix; undefined for any other error. */
function listenError(err: unknown): UsageError | undefined {
  const e = err as NodeJS.ErrnoException & { address?: string; port?: number };
  if (e?.syscall !== 'listen') return undefined;
  const host = e.address?.includes(':') ? `[${e.address}]` : e.address ?? '?';
  return new UsageError(`cannot listen on ${host}:${e.port ?? '?'}: ${(e.code && LISTEN_HINTS[e.code]) ?? e.message}`);
}
