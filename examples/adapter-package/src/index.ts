import {
  defineAdapter, defineLimits, limitProperties, limitValue, noMappings, PORT_VERSIONS,
  type GuardPort, type GuardVerdict, type LimitValue, type Mappings,
} from '@agent-layers/core';

/** Options, validated against `optionsSchema` before `create` runs. */
export interface TemplateOptions {
  /** Words that make the guard block. */
  deny?: string[];
  /** Longest text inspected; longer text is blocked (default 100000). */
  maxTextChars?: LimitValue;
}

/**
 * Configurable limits: every timeout, size, count or truncation length is declared here once, never written as a
 * literal in the code. Each one needs a row in docs/limits.md once the adapter is published (`npm run docs:check`).
 */
export const LIMITS = defineLimits({
  maxTextChars: { path: 'options.maxTextChars', default: 100_000, unit: 'chars', min: 1, unbounded: 'warn', safe: { max: 1_000_000 } },
});

/** `ext` key the adapter writes on its verdicts, in its own namespace (the adapter name), declared in `ext.produces`. */
export const WORD_KEY = 'template.word';

/**
 * Factory: usable directly from code, without the registry. `mappings` applies the `in` rules of the stack config
 * (`mappings.guardrails.<key>.in`) to the native result: here `{ word }`, the matched word.
 */
export function createTemplateGuard(options: TemplateOptions = {}, name = 'template', mappings: Mappings = noMappings(name)): GuardPort {
  const deny = (options.deny ?? []).map((w) => w.toLowerCase());
  const maxTextChars = limitValue(LIMITS.maxTextChars, options.maxTextChars);
  return {
    name,
    async check(input) {
      // Fail closed: text over the limit is not inspected, so it is not let through.
      if (input.text.length > maxTextChars) return { action: 'block', reason: 'text too long' };
      const hit = deny.find((w) => input.text.toLowerCase().includes(w));
      if (!hit) return { action: 'allow' };
      const verdict: GuardVerdict = { action: 'block', reason: `contains "${hit}"`, ext: { [WORD_KEY]: hit } };
      return mappings.in({ word: hit }, verdict);
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
    properties: {
      deny: { type: 'array', items: { type: 'string' } },
      ...limitProperties(LIMITS, { maxTextChars: 'Longest text inspected; longer text is blocked' }),
    },
    additionalProperties: false,
  },
  limits: LIMITS,
  ext: { produces: [WORD_KEY] },
  // Verdicts are built from the native result through `in` rules on the GuardVerdict shape; none by default.
  mappingDefaults: { in: { shape: 'GuardVerdict' } },
  create: (options, ctx) => createTemplateGuard(options, ctx.name, ctx.mappings),
});

export const adapters = [adapter];
