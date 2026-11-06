import { compose, stopReasonOf, type EvalCase, type EvalResult, type RunResult } from '@agent-layers/core';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UsageError, type Io } from '../io.ts';
import { authenticate, callerContext, reasonLine } from '../identity.ts';
import { openProject } from '../project.ts';

export interface EvalArgs { config?: string; profile?: string; dataset?: string; agent?: string; out?: string; min?: string; token?: string }

/**
 * Runs every case of a JSON Lines dataset through an agent and scores it with the configured evaluators. Exit code 1
 * when the pass rate is below `--min`; without `--min` the exit code is 0 whatever the scores, and a hint says so.
 */
export async function evaluate(io: Io, args: EvalArgs): Promise<number> {
  if (!args.dataset) throw new UsageError('usage: agent-layers eval <dataset.jsonl> --agent <name>');
  const min = parseMin(args.min);
  const p = await openProject(io, args);
  const cases = (await readFile(resolve(io.cwd, args.dataset), 'utf8')).split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l) as EvalCase; } catch { throw new UsageError(`${args.dataset}:${i + 1}: not valid JSON`); }
  });
  const stack = await compose(p.config, { registry: p.registry, env: p.env });
  const lines: string[] = [];
  let total = 0;
  let passed = 0;
  try {
    if (!stack.ports.eval.length) throw new UsageError('no evaluators configured (layers.eval)');
    const name = args.agent ?? stack.agents()[0];
    if (!name) throw new UsageError('no agents configured');
    const caller = await authenticate(stack, p, args.token);
    const agent = await stack.agent(name);
    for (const c of cases) {
      const run: RunResult = await agent.run(c.input, callerContext(caller)).catch((err: unknown) => ({ runId: '', status: 'failed' as const, output: '', reason: stopReasonOf(err) }));
      const scores = (await Promise.all(stack.ports.eval.map((e) => e.score(c, run)))).flat();
      const result: EvalResult = {
        id: c.id, runId: run.runId, output: run.output, status: run.status, scores,
        ...(run.reason ? { reason: run.reason } : {}), ...(run.usage ? { usage: run.usage } : {}), ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
      };
      lines.push(JSON.stringify(result));
      for (const s of scores) { total++; if (s.value >= 1) passed++; }
      io.err(`  ${scores.every((s) => s.value >= 1) && run.status === 'completed' ? 'pass' : 'FAIL'} ${c.id}${run.status !== 'completed' ? ` (${run.status}${run.reason ? `: ${reasonLine(run.reason)}` : ''})` : ''}`);
    }
  } finally {
    await stack.close();
  }
  if (args.out) await writeFile(resolve(io.cwd, args.out), `${lines.join('\n')}\n`);
  else for (const l of lines) io.out(l);
  const rate = total ? passed / total : 0;
  io.err(`${passed}/${total} scores passed (${Math.round(rate * 100)}%)`);
  if (min === undefined && rate < 1) io.err('hint: the exit code is 0 without --min; pass --min 1 to fail the command when a score fails');
  return min !== undefined && rate < min ? 1 : 0;
}

/** `--min` as a pass rate in [0, 1]. Anything else is a usage error, not a threshold that never fails. */
function parseMin(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new UsageError('--min must be a number between 0 and 1');
  return n;
}
