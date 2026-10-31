import { diffProfiles, formatDiff, parseConfig } from '@agent-layers/core';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { UsageError, type Io } from '../io.ts';
import { configPath } from '../project.ts';

/** Prints, slot by slot, what changes between two profiles. Environment variables are not required. */
export async function diff(io: Io, args: { config?: string; a?: string; b?: string }): Promise<number> {
  if (!args.a || !args.b) throw new UsageError('usage: agent-layers diff <profileA> <profileB>');
  const file = configPath(io, args.config);
  const text = await readFile(file, 'utf8');
  const lenient = new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? io.env[k] ?? `\${env:${k}}` : undefined) }) as Record<string, string>;
  const load = (profile: string) => parseConfig(text, { file, dir: dirname(file), env: lenient, profile });
  io.out(formatDiff(diffProfiles(load(args.a), load(args.b)), args.a, args.b));
  return 0;
}
