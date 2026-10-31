import { compose, errorMessage, type EvalCase, type EvalResult } from '@agent-layers/core';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UsageError, type Io } from '../io.ts';
import { openProject } from '../project.ts';

export interface EvalArgs { config?: string; profile?: string; dataset?: string; agent?: string; out?: string; min?: string }

/** Runs every case of a JSON Lines dataset through an agent and scores it with the configured evaluators. */
export async function evaluate(io: Io, args: EvalArgs): Promise<number> {
  if (!args.dataset) throw new UsageError('usage: agent-layers eval <dataset.jsonl> --agent <name>');
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
    const agent = await stack.agent(name);
    for (const c of cases) {
      const run = await agent.run(c.input).catch((err: unknown) => ({ runId: '', status: 'failed', output: '', reason: errorMessage(err) }));
      const scores = (await Promise.all(stack.ports.eval.map((e) => e.score(c, run)))).flat();
      const result: EvalResult = { id: c.id, runId: run.runId, output: run.output, status: String(run.status), scores };
      lines.push(JSON.stringify(result));
      for (const s of scores) { total++; if (s.value >= 1) passed++; }
      io.err(`  ${scores.every((s) => s.value >= 1) && run.status === 'completed' ? 'pass' : 'FAIL'} ${c.id}${run.status !== 'completed' ? ` (${run.status}${'reason' in run && run.reason ? `: ${run.reason}` : ''})` : ''}`);
    }
  } finally {
    await stack.close();
  }
  if (args.out) await writeFile(resolve(io.cwd, args.out), `${lines.join('\n')}\n`);
  else for (const l of lines) io.out(l);
  const rate = total ? passed / total : 0;
  io.err(`${passed}/${total} scores passed (${Math.round(rate * 100)}%)`);
  return args.min !== undefined && rate < Number(args.min) ? 1 : 0;
}
