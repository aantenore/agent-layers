import { AdapterError, ConfigError, MissingLayerError, type Layer } from '@agent-layers/core';
import { parseArgs } from 'node:util';
import { check } from './commands/check.ts';
import { deploy, down } from './commands/deploy.ts';
import { dev } from './commands/dev.ts';
import { diff } from './commands/diff.ts';
import { evaluate } from './commands/eval.ts';
import { gateway } from './commands/gateway.ts';
import { init } from './commands/init.ts';
import { layers } from './commands/layers.ts';
import { test } from './commands/test.ts';
import { processIo, UsageError, type Io } from './io.ts';

export { processIo, type Io } from './io.ts';

const HELP = `agent-layers <command> [options]

  init [dir]                 scaffold a project (--template minimal|rag, --runtime <adapter>, --name, --agent, --force, --yes)
  dev                        run the agent in the terminal with a trace line per layer (--agent, --message, --no-deploy, --token)
  check                      validate config, resolve adapters, readiness gate, conformance (--skip-conformance)
  test                       conformance plus reference and project tests (--layer <id>, --token)
  eval <dataset.jsonl>       run and score a dataset (--agent, --out <file>, --min <0..1>, --token)
  deploy                     plan and start the services through the deploy slot (--dry-run)
  up | down                  start or stop the services of a profile
  diff <profileA> <profileB> what changes between two profiles, slot by slot
  layers                     the eleven layers: ports, versions, adapters in use and installed
  gateway                    host the stack on the network: mounted channels and triggers, identity on every request (--port, --host)

Callers: --token <t> or AGENT_LAYERS_TOKEN authenticates dev, eval and test runs (prototype profiles default to the static-identity dev token)
Common options: --config <file> (default agent-layers.json), --profile <name> (or AGENT_LAYERS_PROFILE)`;

const OPTIONS = {
  config: { type: 'string' }, profile: { type: 'string' }, layer: { type: 'string' }, agent: { type: 'string' },
  template: { type: 'string' }, runtime: { type: 'string' }, name: { type: 'string' }, out: { type: 'string' },
  min: { type: 'string' }, message: { type: 'string' }, force: { type: 'boolean' }, yes: { type: 'boolean' },
  'dry-run': { type: 'boolean' }, 'skip-conformance': { type: 'boolean' }, 'no-deploy': { type: 'boolean' },
  trace: { type: 'boolean' }, token: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, help: { type: 'boolean', short: 'h' },
} as const;

/** Runs one command. Resolves to the exit code; never calls process.exit. */
export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') { io.out(HELP); return 0; }
  try {
    const { values: v, positionals: pos } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
    if (v.help) { io.out(HELP); return 0; }
    const common = { ...(v.config ? { config: v.config } : {}), ...(v.profile ? { profile: v.profile } : {}) };
    switch (command) {
      case 'init': return await init(io, { ...(pos[0] ? { dir: pos[0] } : {}), ...pick(v, ['template', 'runtime', 'name', 'agent', 'force', 'yes']) });
      case 'dev': return await dev(io, { ...common, ...pick(v, ['agent', 'message', 'trace', 'token']), ...(v['no-deploy'] ? { noDeploy: true } : {}) });
      case 'check': return await check(io, { ...common, ...(v.layer ? { layer: v.layer as Layer } : {}), ...(v['skip-conformance'] ? { skipConformance: true } : {}) });
      case 'test': return await test(io, { ...common, ...pick(v, ['layer', 'token']) });
      case 'eval': return await evaluate(io, { ...common, ...(pos[0] ? { dataset: pos[0] } : {}), ...pick(v, ['agent', 'out', 'min', 'token']) });
      case 'deploy': case 'up': return await deploy(io, { ...common, ...(v['dry-run'] ? { dryRun: true } : {}) });
      case 'down': return await down(io, { ...common, ...(v['dry-run'] ? { dryRun: true } : {}) });
      case 'diff': return await diff(io, { ...common, ...(pos[0] ? { a: pos[0] } : {}), ...(pos[1] ? { b: pos[1] } : {}) });
      case 'layers': return await layers(io, common);
      case 'gateway': return await gateway(io, { ...common, ...pick(v, ['port', 'host']) });
      default: throw new UsageError(`unknown command "${command}"\n\n${HELP}`);
    }
  } catch (err) {
    if (err instanceof UsageError || err instanceof ConfigError || err instanceof AdapterError || err instanceof MissingLayerError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      io.err(`agent-layers ${command}: ${(err as Error).message}`);
      return 1;
    }
    throw err;
  }
}

function pick<T extends Record<string, unknown>, K extends keyof T>(v: T, keys: K[]): { [P in K]?: Exclude<T[P], undefined> } {
  return Object.fromEntries(keys.filter((k) => v[k] !== undefined).map((k) => [k, v[k]])) as never;
}
