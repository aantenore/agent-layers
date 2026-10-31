import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Run, RunResult } from '../src/index.ts';

/** Temp project: reference/llm, legacy layers/l3-knowledge and layers/l4-tools. */
export async function tempProject(extra: Record<string, string> = {}): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'compose-deploy-'));
  const files: Record<string, string> = {
    'reference/llm/compose.yml': 'services:\n  ollama:\n    image: ollama/ollama\n',
    'layers/l3-knowledge/compose.yml': 'services:\n  qdrant:\n    image: qdrant/qdrant\n',
    'layers/l4-tools/compose.yml': 'services:\n  bridge:\n    image: bridge\n',
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** All files below a directory, sorted, as relative paths. */
export const listing = async (root: string): Promise<string[]> =>
  (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(root.length + 1)).sort();

export interface Call { cmd: string; args: string[]; cwd: string }

/** Fake runner: records calls, answers with `result` (or per-call). */
export function fakeRun(result: RunResult | ((c: Call) => RunResult) = { code: 0, stdout: '', stderr: '' }): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    run: async (cmd, args, opts) => {
      const call = { cmd, args, cwd: opts.cwd };
      calls.push(call);
      return typeof result === 'function' ? result(call) : result;
    },
  };
}
