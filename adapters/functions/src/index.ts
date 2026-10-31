import { defineAdapter, PORT_VERSIONS, type ToolPort } from '@agent-layers/core';
import { loadTools } from './load.ts';
import { defineTool, functionTools, type ToolDef } from './tool.ts';

export { defineTool, functionTools, type ToolDef };

/** Options, validated against `optionsSchema` before `create` runs. */
export interface FunctionsOptions {
  /** Module with the tools: a path relative to the config directory, or a package specifier. */
  module?: string;
  /** Definitions passed from code (not expressible in a JSON config). */
  tools?: ToolDef[];
}

/** Factory: usable directly from code, without the registry. */
export async function createFunctionTools(options: FunctionsOptions = {}, { cwd = process.cwd(), name = 'functions' } = {}): Promise<ToolPort> {
  const defs = [...(options.tools ?? []), ...(options.module ? await loadTools(options.module, cwd) : [])];
  return functionTools(defs, name);
}

/** Descriptor: what the registry and the CLI see. */
export const adapter = defineAdapter<'ToolPort', FunctionsOptions>({
  layer: 'tool',
  port: 'ToolPort',
  name: 'functions',
  direction: 'outbound',
  maps: { technology: 'JavaScript functions' },
  portVersion: PORT_VERSIONS.ToolPort,
  tiers: ['prototype', 'production'],
  description: 'Exposes JavaScript functions, from a module or from code, as tools.',
  optionsSchema: {
    type: 'object',
    properties: {
      module: { type: 'string', minLength: 1 },
      tools: { type: 'array', items: { type: 'object' } },
    },
    additionalProperties: false,
  },
  create: (options, ctx) => createFunctionTools(options, { cwd: ctx.cwd, name: ctx.name }),
});

export const adapters = [adapter];
