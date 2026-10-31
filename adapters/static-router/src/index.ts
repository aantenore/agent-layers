import { defineAdapter, PORT_VERSIONS, type RouterPort } from '@agent-layers/core';

export interface StaticRouterOptions {
  /** Model used when no agent or alias rule applies. */
  model?: string;
  /** Agent name → model. */
  agents?: Record<string, string>;
  /** Requested model → model. */
  aliases?: Record<string, string>;
}

/** Router that picks the model from fixed mappings: agent first, then alias, then default, then the requested model. */
export function createStaticRouter(options: StaticRouterOptions = {}, name = 'static-router'): RouterPort {
  const { agents = {}, aliases = {}, model } = options;
  const own = (map: Record<string, string>, key: string) => (Object.hasOwn(map, key) ? map[key] : undefined);
  return {
    name,
    select: (req, ctx) => own(agents, ctx.agent) ?? own(aliases, req.model) ?? model ?? req.model,
  };
}

const modelMap = { type: 'object', additionalProperties: { type: 'string', minLength: 1 } };

export const adapter = defineAdapter<'RouterPort', StaticRouterOptions>({
  layer: 'cache',
  port: 'RouterPort',
  name: 'static-router',
  direction: 'outbound',
  maps: { technology: 'static model mapping' },
  portVersion: PORT_VERSIONS.RouterPort,
  tiers: ['prototype', 'production'],
  description: 'Picks the model from fixed per-agent and per-alias mappings, with an optional default.',
  optionsSchema: {
    type: 'object',
    properties: {
      model: { type: 'string', minLength: 1 },
      agents: modelMap,
      aliases: modelMap,
    },
    additionalProperties: false,
  },
  create: (options, ctx) => createStaticRouter(options, ctx.name),
});

export const adapters = [adapter];
