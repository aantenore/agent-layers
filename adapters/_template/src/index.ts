import { defineAdapter, PORT_VERSIONS, type GuardPort } from '@agent-layers/core';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface TemplateOptions {
  /** Words that make the guard block. */
  deny?: string[];
}

/** Factory: usable directly from code, without the registry. */
export function createTemplateGuard(options: TemplateOptions = {}, name = 'template'): GuardPort {
  const deny = (options.deny ?? []).map((w) => w.toLowerCase());
  return {
    name,
    async check(input) {
      const hit = deny.find((w) => input.text.toLowerCase().includes(w));
      return hit ? { action: 'block', reason: `contains "${hit}"` } : { action: 'allow' };
    },
  };
}

/** Descriptor: what the registry and the CLI see. Name it after the standard or technology it maps. */
export const adapter = defineAdapter<'GuardPort', TemplateOptions>({
  layer: 'guardrail',
  port: 'GuardPort',
  name: 'template',
  direction: 'outbound',
  maps: { technology: 'word list' },
  portVersion: PORT_VERSIONS.GuardPort,
  tiers: ['prototype'],
  description: 'Skeleton adapter: blocks text containing configured words.',
  optionsSchema: {
    type: 'object',
    properties: { deny: { type: 'array', items: { type: 'string' } } },
    additionalProperties: false,
  },
  create: (options, ctx) => createTemplateGuard(options, ctx.name),
});

export const adapters = [adapter];
