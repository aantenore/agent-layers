import { isLayer, LAYERS, type Layer } from '@agent-layers/core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError, type Io } from '../io.ts';
import { TOKEN_ENV } from '../identity.ts';
import { configPath } from '../project.ts';
import { check } from './check.ts';

/** Test folder of the reference setup of a layer: reference/<layer id>/test. */
export function referenceTests(root: string, layer: Layer): string[] {
  const dir = join(root, 'reference', layer, 'test');
  return existsSync(dir) ? [dir] : [];
}

/** Conformance for the configured adapters, then the reference live tests and the project's own tests. */
export async function test(io: Io, args: { config?: string; profile?: string; layer?: string; token?: string }): Promise<number> {
  if (args.layer && !isLayer(args.layer)) throw new UsageError(`unknown layer "${args.layer}" (one of ${LAYERS.map((l) => l.layer).join(', ')})`);
  const layer = args.layer as Layer | undefined;
  const { layer: _l, token, ...rest } = args;
  let code = await check(io, { ...rest, ...(layer ? { layer } : {}) });
  const root = configPath(io, args.config).replace(/\/[^/]+$/, '');
  const dirs = (layer ? [layer] : LAYERS.map((l) => l.layer)).flatMap((l) => referenceTests(root, l));
  if (!layer && existsSync(join(root, 'tests'))) dirs.push(join(root, 'tests'));
  const env = token ? { ...io.env, [TOKEN_ENV]: token } : io.env;
  for (const dir of dirs) {
    io.out(`node --test ${dir}`);
    code = Math.max(code, await run(process.execPath, ['--test', `${dir}/**/*.test.{ts,mjs,js}`], root, env, io));
  }
  return code;
}

function run(cmd: string, argv: string[], cwd: string, env: Record<string, string | undefined>, io: Io): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b: Buffer) => io.out(b.toString().trimEnd()));
    child.stderr.on('data', (b: Buffer) => io.err(b.toString().trimEnd()));
    child.on('close', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });
}
