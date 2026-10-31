import { readiness, type Layer } from '@agent-layers/core';
import { conformAll } from '../conform.ts';
import { resolveToken } from '../identity.ts';
import type { Io } from '../io.ts';
import { openProject } from '../project.ts';

export interface CheckArgs { config?: string; profile?: string; layer?: Layer; skipConformance?: boolean; token?: string }

/**
 * Validates the config, resolves every adapter, applies the readiness gate and runs conformance. Exit code 0 or 1.
 * The caller (`--token`, AGENT_LAYERS_TOKEN, or the prototype dev token) is verified and used by the probes that act for one.
 */
export async function check(io: Io, args: CheckArgs): Promise<number> {
  const p = await openProject(io, args);
  const c = p.config;
  io.out(`profile ${c.profile ?? '(base)'}${c.chain.length > 1 ? ` (${c.chain.join(' → ')})` : ''} · tier ${c.tier}`);
  const ready = await readiness(c, p.registry);
  if (ready.requires.length) io.out(`requires: ${ready.requires.join(', ')}`);
  for (const problem of ready.problems) io.out(`  FAIL ${problem.message}`);
  let failed = !ready.ok;
  const blocking = ready.problems.some((x) => x.kind === 'not-installed' || x.kind === 'load-failed');
  if (args.skipConformance) io.out('conformance: skipped');
  else if (blocking) io.out('conformance: skipped until every adapter is installed');
  else {
    const token = resolveToken(p, args.token);
    const { reports, error, callerError } = await conformAll(p, { env: p.env, ...(args.layer ? { layer: args.layer } : {}), ...(token ? { token } : {}) });
    if (error) { io.out(`  FAIL compose: ${error}`); failed = true; }
    if (callerError) { io.out(`  FAIL caller: ${callerError}`); failed = true; }
    for (const r of reports) {
      io.out(`  ${r.status === 'ok' ? 'ok  ' : r.status === 'skip' ? 'skip' : 'FAIL'} ${r.entry.slot.padEnd(14)} ${r.entry.key === r.entry.ref.adapter ? r.entry.ref.adapter : `${r.entry.key}=${r.entry.ref.adapter}`} (${r.entry.port})`);
      for (const d of r.detail) io.out(`         ${d}`);
      if (r.status === 'fail') failed = true;
    }
  }
  io.out(failed ? 'check failed' : 'check passed');
  return failed ? 1 : 0;
}
