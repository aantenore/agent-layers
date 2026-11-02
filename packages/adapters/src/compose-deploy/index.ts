import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  anySignal, defineAdapter, limitProperties, limitValue, PORT_VERSIONS, timeoutSignal,
  type DeployOptions, type DeployPlan, type DeployPort, type Endpoint, type Layer, type LimitValue, type ServiceSpec,
} from '@agent-layers/core';
import { composeFor, LIMITS, type HealthOptions } from './generate.ts';
import { layerFile } from './resolve.ts';
import { shellLine, spawnRun, type Run } from './run.ts';

export type { Run, RunOptions, RunResult } from './run.ts';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface ComposeDeployOptions extends HealthOptions {
  /** Directory commands run in and paths resolve against (default: the stack config directory). */
  root?: string;
  /** Compose project name (default `agent-layers`). */
  projectName?: string;
  /** Env file passed to Compose (default `.env` when it exists in the root). */
  envFile?: string;
  /** Compose file per layer id, overriding the search. */
  files?: Record<string, string>;
  /** Directories searched for reference compose files (default `reference`, `layers`). */
  searchDirs?: string[];
  /** Compose command (default `docker compose`). */
  command?: string[];
  /** Wait for services to be running or healthy on `up` (default true). */
  wait?: boolean;
  /** Longest one Compose invocation may run before it is stopped (default 600000 ms; `"unbounded"` disables it). */
  commandTimeoutMs?: LimitValue;
  /** Characters of the command output kept in the error message when Compose fails (default 500). */
  errorOutputChars?: number;
}

export const GENERATED_FILE = '.agent-layers/compose.generated.yml';

interface Prepared { plan: DeployPlan; lines: string[][]; endpoints: Endpoint[]; generated?: { path: string; content: string } }

/** Factory: usable directly from code, without the registry. `run` is injectable for tests. */
export function createComposeDeploy(
  options: ComposeDeployOptions = {},
  { cwd = process.cwd(), run = spawnRun, name = 'compose-deploy' }: { cwd?: string; run?: Run; name?: string } = {},
): DeployPort {
  const root = resolve(cwd, options.root ?? '.');
  const project = options.projectName ?? 'agent-layers';
  const command = options.command ?? ['docker', 'compose'];
  const searchDirs = options.searchDirs ?? ['reference'];
  const wait = options.wait ?? true;
  const commandTimeoutMs = limitValue(LIMITS.commandTimeoutMs, options.commandTimeoutMs);
  const errorOutputChars = limitValue(LIMITS.errorOutputChars, options.errorOutputChars);

  /** One Compose invocation per file: relative paths inside a reference file keep resolving against its own folder. */
  async function prepare(services: ServiceSpec[], verb: 'up' | 'down'): Promise<Prepared> {
    const own: ServiceSpec[] = [];
    const layers = new Map<Layer, string | undefined>();
    const endpoints: Endpoint[] = [];
    for (const s of services) {
      if (s.image) own.push(s);
      else if (s.layer) {
        if (!layers.has(s.layer)) layers.set(s.layer, await layerFile(s.layer, { root, files: options.files ?? {}, searchDirs }));
        if (!layers.get(s.layer)) continue;
      } else throw new Error(`service "${s.name}": needs an image or a layer`);
      for (const port of s.ports ?? []) endpoints.push({ service: s.name, url: `http://localhost:${port}` });
    }
    const envFile = options.envFile ?? (existsSync(resolve(root, '.env')) ? '.env' : undefined);
    const files = [...new Set([...layers.values()].filter((f): f is string => !!f))];
    const generated = own.length ? { path: GENERATED_FILE, content: composeFor(own, options) } : undefined;
    if (generated) files.push(generated.path);
    const tail = verb === 'up' ? ['up', '-d', ...(wait ? ['--wait'] : [])] : ['down'];
    const lines = files.map((f) => [...command, '-p', project, '-f', f, ...(envFile ? ['--env-file', envFile] : []), ...tail]);
    if (verb === 'down') lines.reverse();
    const notes = [...layers].filter(([, f]) => !f).map(([layer]) => `# no compose file for layer ${layer}`);
    return {
      plan: { artifacts: generated ? [generated] : [], steps: [...notes, ...lines.map(shellLine)] },
      lines,
      endpoints,
      generated,
    };
  }

  async function execute(services: ServiceSpec[], verb: 'up' | 'down', opts: DeployOptions): Promise<Endpoint[]> {
    const p = await prepare(services, verb);
    if (opts.dryRun) return p.endpoints;
    if (p.generated) {
      const path = resolve(root, p.generated.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, p.generated.content);
    }
    for (const [cmd, ...args] of p.lines) {
      const timeout = timeoutSignal(commandTimeoutMs);
      const signal = anySignal(opts.signal, timeout);
      const res = await run(cmd!, args, { cwd: root, ...(signal ? { signal } : {}) });
      if (res.code !== 0 && timeout?.aborted && !opts.signal?.aborted) {
        // The output of a killed command is partial and may carry secrets: it stays out of the message.
        throw new Error(`compose ${verb} timed out after ${commandTimeoutMs} ms and was stopped`);
      }
      if (res.code !== 0) throw new Error(`compose ${verb} failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, errorOutputChars)}`);
    }
    return p.endpoints;
  }

  return {
    name,
    async plan(services) {
      return (await prepare(services, 'up')).plan;
    },
    up: (services, opts = {}) => execute(services, 'up', opts),
    async down(services, opts = {}) {
      await execute(services, 'down', opts);
    },
    native: () => ({ root, project, command }),
  };
}

/** Descriptor: what the registry and the CLI see. */
export const adapter = defineAdapter<'DeployPort', ComposeDeployOptions>({
  layer: 'infra',
  port: 'DeployPort',
  name: 'compose-deploy',
  direction: 'outbound',
  maps: { standard: 'Compose Specification' },
  portVersion: PORT_VERSIONS.DeployPort,
  tiers: ['prototype', 'production'],
  description: 'Runs services with Docker Compose: layer reference files plus a generated file for image services.',
  optionsSchema: {
    type: 'object',
    properties: {
      root: { type: 'string' },
      projectName: { type: 'string', minLength: 1 },
      envFile: { type: 'string' },
      files: { type: 'object', additionalProperties: { type: 'string' } },
      searchDirs: { type: 'array', items: { type: 'string' } },
      command: { type: 'array', minItems: 1, items: { type: 'string' } },
      wait: { type: 'boolean' },
      ...limitProperties(LIMITS, {
        healthIntervalS: 'Seconds between health checks of the generated services',
        healthTimeoutS: 'Seconds a health check may take',
        healthRetries: 'Failed health checks before a service counts as unhealthy',
        commandTimeoutMs: 'Longest one docker compose invocation may run before it is stopped',
        errorOutputChars: 'Characters of the command output kept in the error message when Compose fails',
      }),
    },
    additionalProperties: false,
  },
  limits: LIMITS,
  create: (options, ctx) => createComposeDeploy(options, { cwd: ctx.cwd, name: ctx.name }),
});

export const adapters = [adapter];
