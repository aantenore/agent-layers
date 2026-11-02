import { defineAdapter, PORT_VERSIONS, type CallPart, type ModelRequest, type Part, type RouterPort } from '@agent-layers/core';

/** Conditions on a request. All that are set must hold. */
export interface RouteCondition {
  /** Estimated size of the request, in tokens (about 4 characters each: messages, tool calls and tool definitions). */
  minEstTokens?: number;
  maxEstTokens?: number;
  /** Whether the request offers tools (`toolMode: "none"` counts as none). */
  hasTools?: boolean;
  /** The request is for this turn or a later one: turn N follows N-1 assistant messages. */
  turnAtLeast?: number;
}

export interface RouteRule { when: RouteCondition; model: string }

/** Options, validated against `optionsSchema` before `create` runs. */
export interface RuleRouterOptions {
  /** Checked in order; the first rule whose conditions hold picks the model. */
  rules: RouteRule[];
  /** Model when no rule matches (default: the model the request asked for). */
  default?: string;
}

const CONDITIONS = ['minEstTokens', 'maxEstTokens', 'hasTools', 'turnAtLeast'] as const;

/** Characters of one part: text of text, reasoning and result parts, the JSON of a call; media counts nothing. */
function partChars(p: Part): number {
  if (p.type === 'text' || p.type === 'reasoning' || p.type === 'result') return String((p as { text?: unknown }).text ?? '').length;
  if (p.type === 'call') {
    const c = p as CallPart;
    return c.tool.length + (c.invalid ?? JSON.stringify(c.args ?? {})).length;
  }
  return 0;
}

/** Rough token estimate of a request: characters / 4 over message parts, tool calls and tool definitions. */
export function estimateTokens(req: ModelRequest): number {
  let chars = 0;
  for (const m of req.messages) for (const p of m.parts) chars += partChars(p);
  if (req.tools?.length) chars += JSON.stringify(req.tools).length;
  return Math.ceil(chars / 4);
}

const turnOf = (req: ModelRequest) => 1 + req.messages.filter((m) => m.role === 'assistant').length;
const offersTools = (req: ModelRequest) => (req.tools?.length ?? 0) > 0 && req.toolMode !== 'none';

function matches(when: RouteCondition, req: ModelRequest): boolean {
  if (when.hasTools !== undefined && offersTools(req) !== when.hasTools) return false;
  if (when.turnAtLeast !== undefined && turnOf(req) < when.turnAtLeast) return false;
  if (when.minEstTokens !== undefined || when.maxEstTokens !== undefined) {
    const est = estimateTokens(req);
    if (when.minEstTokens !== undefined && est < when.minEstTokens) return false;
    if (when.maxEstTokens !== undefined && est > when.maxEstTokens) return false;
  }
  return true;
}

/** Factory: a router that picks the model from rules on request size, tools and turn. Makes no calls. */
export function createRuleRouter(options: RuleRouterOptions, name = 'rule-router'): RouterPort {
  const rules = options.rules ?? [];
  for (const [i, r] of rules.entries()) {
    if (!r || typeof r.model !== 'string' || !r.model) throw new Error(`rule ${i} needs a model`);
    if (!r.when || typeof r.when !== 'object' || !CONDITIONS.some((k) => r.when[k] !== undefined)) throw new Error(`rule ${i} needs at least one condition in "when"`);
    if (r.when.minEstTokens !== undefined && r.when.maxEstTokens !== undefined && r.when.minEstTokens > r.when.maxEstTokens) {
      throw new Error(`rule ${i}: minEstTokens is above maxEstTokens`);
    }
  }
  return {
    name,
    native: () => ({ rules }),
    select: (req) => rules.find((r) => matches(r.when, req))?.model ?? options.default ?? req.model,
  };
}

export const adapter = defineAdapter<'RouterPort', RuleRouterOptions>({
  layer: 'cache',
  port: 'RouterPort',
  name: 'rule-router',
  direction: 'outbound',
  maps: { technology: 'local routing rules' },
  portVersion: PORT_VERSIONS.RouterPort,
  tiers: ['prototype', 'production'],
  description: 'Picks the model from ordered rules on estimated request size, tool use and turn number.',
  optionsSchema: {
    type: 'object',
    properties: {
      rules: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            when: {
              type: 'object',
              properties: {
                minEstTokens: { type: 'integer', minimum: 0 },
                maxEstTokens: { type: 'integer', minimum: 0 },
                hasTools: { type: 'boolean' },
                turnAtLeast: { type: 'integer', minimum: 1 },
              },
              additionalProperties: false,
            },
            model: { type: 'string', minLength: 1 },
          },
          required: ['when', 'model'],
          additionalProperties: false,
        },
      },
      default: { type: 'string', minLength: 1 },
    },
    required: ['rules'],
    additionalProperties: false,
  },
  create: (options, ctx) => createRuleRouter(options, ctx.name),
});

export const adapters = [adapter];
