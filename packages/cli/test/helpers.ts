import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Io } from '../src/io.ts';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** Io that captures output; `env` defaults to an empty environment so tests do not depend on the host. */
export function captureIo(cwd: string, env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { cwd, env, stdin: new PassThrough(), out: (t) => out.push(t), err: (t) => err.push(t) };
  return { io, out, err, text: () => out.join('\n'), errors: () => err.join('\n') };
}

/** A temp folder whose node_modules points at the workspace, so generated projects resolve @agent-layers/*. */
export async function tempProject(): Promise<{ dir: string; root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-layers-cli-'));
  const dir = join(root, 'proj');
  return { dir, root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function linkModules(dir: string): Promise<void> {
  await symlink(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'dir');
}
