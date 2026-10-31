import { defineAdapter, evaluatePolicy, PORT_VERSIONS, subjectOf, type AuthorizationPort, type PolicyRule } from '@agent-layers/core';

export interface RulesAuthorizationOptions {
  /** Rules in order; the first one that matches decides. */
  rules: PolicyRule[];
  /** Decision when no rule matches. */
  default?: 'allow' | 'deny';
}

/**
 * Authorization from a local rule list. `ask` means "not allowed without approval": the core consults
 * the ApprovalPort before it reaches this port, so a request that gets here with `ask` is refused.
 */
export function createRulesAuthorization(options: RulesAuthorizationOptions, name = 'rules-authorization'): AuthorizationPort {
  const fallback = options.default ?? 'deny';
  return {
    name,
    async evaluate(req) {
      switch (evaluatePolicy(options.rules, subjectOf(req))) {
        case 'allow': return { decision: true, context: { reason: 'allowed by rule' } };
        case 'deny': return { decision: false, context: { reason: 'denied by rule' } };
        case 'ask': return { decision: false, context: { reason: 'approval required' } };
        default: return { decision: fallback === 'allow', context: { reason: `no rule matched (default ${fallback})` } };
      }
    },
  };
}

const strings = { type: 'array', items: { type: 'string' } };

export const adapter = defineAdapter<'AuthorizationPort', RulesAuthorizationOptions>({
  layer: 'identity',
  port: 'AuthorizationPort',
  name: 'rules-authorization',
  direction: 'outbound',
  maps: { technology: 'local rule list' },
  portVersion: PORT_VERSIONS.AuthorizationPort,
  tiers: ['prototype', 'production'],
  description: 'Decides tool access from an ordered list of allow, ask and deny rules. Fails closed by default.',
  optionsSchema: {
    type: 'object',
    properties: {
      rules: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            effect: { enum: ['allow', 'ask', 'deny'] },
            tools: strings,
            risk: { type: 'array', items: { enum: ['read', 'write', 'exec'] } },
            when: {
              type: 'object',
              properties: { roles: strings, scopes: strings, kind: { enum: ['user', 'agent'] } },
              additionalProperties: false,
            },
          },
          required: ['effect'],
          additionalProperties: false,
        },
      },
      default: { enum: ['allow', 'deny'] },
    },
    required: ['rules'],
    additionalProperties: false,
  },
  create: (options, ctx) => createRulesAuthorization(options, ctx.name),
});

export const adapters = [adapter];
