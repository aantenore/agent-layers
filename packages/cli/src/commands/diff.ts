import { diffProfiles, formatDiff, parseConfig } from '@agent-layers/core';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { UsageError, type Io } from '../io.ts';
import { configPath } from '../project.ts';

/**
 * Prints, slot by slot, what changes between two profiles. Environment variables are not required: defaults apply,
 * and the variables without one that are not set are listed and keep their `${env:...}` reference in the output.
 */
export async function diff(io: Io, args: { config?: string; a?: string; b?: string }): Promise<number> {
  if (!args.a || !args.b) throw new UsageError('usage: agent-layers diff <profileA> <profileB>');
  const file = configPath(io, args.config);
  const dir = dirname(file);
  const text = await readFile(file, 'utf8');
  const missing = new Set<string>();
  const load = (profile: string) => parseConfig(text, { file, dir, env: io.env, profile, deferredEnv: missing });
  io.out(formatDiff(diffProfiles(load(args.a), load(args.b)), args.a, args.b));
  if (missing.size) io.out(`would need: ${[...missing].sort().join(', ')} (not set)`);
  return 0;
}
