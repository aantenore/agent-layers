import { compose, readiness, type Identity, type Stack } from '@agent-layers/core';
import { createInterface } from 'node:readline';
import { UsageError, type Io } from '../io.ts';
import { openProject } from '../project.ts';
import { authenticate, callerContext, runAs } from '../identity.ts';
import { traceTelemetry } from '../trace.ts';
import { servicesOf } from './deploy.ts';

export interface DevArgs { config?: string; profile?: string; agent?: string; message?: string; noDeploy?: boolean; trace?: boolean; token?: string }

/**
 * Composes the stack for a profile, starts reference services through the deploy slot (if any are needed),
 * then talks to the agent: through the configured channels, or a built-in terminal loop. `--message` runs once.
 */
export async function dev(io: Io, args: DevArgs): Promise<number> {
  const p = await openProject(io, args);
  const ready = await readiness(p.config, p.registry);
  const missing = ready.problems.filter((x) => x.kind === 'not-installed' || x.kind === 'load-failed');
  if (missing.length) throw new UsageError(missing.map((m) => m.message).join('\n'));
  const trace = args.trace ?? !(p.config.layers.telemetry as unknown[] | undefined)?.length;
  const stack = await compose(p.config, { registry: p.registry, env: p.env, ...(trace ? { telemetry: [traceTelemetry(io.err)] } : {}) });
  try {
    if (p.config.layers.deploy && !args.noDeploy) {
      const services = (await servicesOf(p)).filter((s) => s.image);
      if (services.length && stack.ports.deploy) {
        io.err(`starting ${services.length} reference service(s)…`);
        for (const e of await stack.ports.deploy.up(services)) io.err(`  ${e.service} ${e.url}`);
      }
    }
    const agent = args.agent ?? stack.agents()[0];
    if (!agent) throw new UsageError('no agents configured');
    const identity = await authenticate(stack, p, args.token);
    if (args.message !== undefined) return await once(stack, agent, args.message, io, identity);
    if (stack.ports.channels.length && !args.agent) {
      runAs(stack, identity);
      const handle = await stack.start();
      await (handle.done ?? new Promise<void>((r) => process.once('SIGINT', () => r())));
      await handle.close();
      return 0;
    }
    return await repl(stack, agent, io, identity);
  } finally {
    await stack.close();
  }
}

async function once(stack: Stack, agent: string, message: string, io: Io, identity: Identity | undefined): Promise<number> {
  const r = await (await stack.agent(agent)).run(message, callerContext(identity));
  io.out(r.status === 'completed' ? r.output : `[${r.status}] ${r.reason ?? ''}`.trim());
  return r.status === 'completed' ? 0 : 1;
}

async function repl(stack: Stack, agent: string, io: Io, identity: Identity | undefined): Promise<number> {
  io.err(`Talking to ${agent} (profile ${stack.config.profile ?? 'base'}). Empty line or Ctrl+D to quit.`);
  const rl = createInterface({ input: io.stdin, terminal: false });
  const runnable = await stack.agent(agent);
  const sessionId = `dev-${Date.now()}`;
  for await (const line of rl) {
    if (!line.trim() || line.trim() === '/exit') break;
    const r = await runnable.run(line, { sessionId, ...callerContext(identity) });
    io.out(r.status === 'completed' ? r.output : `[${r.status}] ${r.reason ?? ''}`.trim());
  }
  rl.close();
  return 0;
}
