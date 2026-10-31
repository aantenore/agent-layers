import { isLayer, LAYERS, type Layer } from '@agent-layers/core';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError, type Io } from '../io.ts';
import { configPath } from '../project.ts';
import { check } from './check.ts';

const LEGACY: Partial<Record<Layer, string>> = { tool: 'tools', guardrail: 'guardrails', cache: 'cache-router' };

/** Test folders of the reference setup of a layer: reference/<id>/test, or a legacy layers/l<n>-<name>/test. */
export function referenceTests(root: string, layer: Layer): string[] {
  const out: string[] = [];
  const direct = join(root, 'reference', layer, 'test');
  if (existsSync(direct)) out.push(direct);
  const legacy = join(root, 'layers');
  if (existsSync(legacy)) {
    for (const d of readdirSync(legacy)) {
      const base = d.replace(/^l\d+-/, '');
      if ((base === layer || base === LEGACY[layer]) && existsSync(join(legacy, d, 'test'))) out.push(join(legacy, d, 'test'));
    }
  }
  return out;
}

/** Conformance for the configured adapters, then the reference live tests and the project's own tests. */
export async function test(io: Io, args: { config?: string; profile?: string; layer?: string }): Promise<number> {
  if (args.layer && !isLayer(args.layer)) throw new UsageError(`unknown layer "${args.layer}" (one of ${LAYERS.map((l) => l.layer).join(', ')})`);
  const layer = args.layer as Layer | undefined;
  const { layer: _l, ...rest } = args;
  let code = await check(io, { ...rest, ...(layer ? { layer } : {}) });
  const root = configPath(io, args.config).replace(/\/[^/]+$/, '');
  const dirs = (layer ? [layer] : LAYERS.map((l) => l.layer)).flatMap((l) => referenceTests(root, l));
  if (!layer && existsSync(join(root, 'tests'))) dirs.push(join(root, 'tests'));
  for (const dir of dirs) {
    io.out(`node --test ${dir}`);
    code = Math.max(code, await run(process.execPath, ['--test', `${dir}/**/*.test.{ts,mjs,js}`], root, io));
  }
  return code;
}

function run(cmd: string, argv: string[], cwd: string, io: Io): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, env: io.env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b: Buffer) => io.out(b.toString().trimEnd()));
    child.stderr.on('data', (b: Buffer) => io.err(b.toString().trimEnd()));
    child.on('close', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });
}
