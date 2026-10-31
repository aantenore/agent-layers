import { CORE_VOCABULARIES, defineAdapter, evaluatePolicy, PORT_VERSIONS, policySubject, VOCAB_NAME, type AuthorizationPort, type PolicyRule, type Vocabularies } from '@agent-layers/core';

/** A policy rule of the core; `when.authenticated: true` matches only a verified caller, `false` only an anonymous one. */
export type RulesAuthorizationRule = PolicyRule;

export interface RulesAuthorizationOptions {
  /** Rules in order; the first one that matches decides. */
  rules: RulesAuthorizationRule[];
  /** Decision when no rule matches. */
  default?: 'allow' | 'deny';
}

/**
 * Authorization from a local rule list. `ask` means "not allowed without approval": the core consults
 * the ApprovalPort before it reaches this port, so a question that gets here with `ask` is refused.
 * `vocabularies` is read at each call (the stack's, so risks added in config match the rules on their `like` value);
 * without it, or while it is unavailable, only core values count and an unknown risk is treated as `exec`.
 */
export function createRulesAuthorization(options: RulesAuthorizationOptions, name = 'rules-authorization', vocabularies?: () => Vocabularies | undefined): AuthorizationPort {
  const fallback = options.default ?? 'deny';
  const vocab = (): Vocabularies => {
    try { return vocabularies?.() ?? CORE_VOCABULARIES; } catch { return CORE_VOCABULARIES; }
  };
  return {
    name,
    async evaluate(q) {
      const v = vocab();
      switch (evaluatePolicy(options.rules, policySubject(q, v), v)) {
        case 'allow': return { allowed: true, reason: 'allowed by rule' };
        case 'deny': return { allowed: false, reason: 'denied by rule' };
        case 'ask': return { allowed: false, reason: 'approval required' };
        default: return { allowed: fallback === 'allow', reason: `no rule matched (default ${fallback})` };
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
            risk: { type: 'array', items: { type: 'string', pattern: VOCAB_NAME.source } },
            when: {
              type: 'object',
              properties: { roles: strings, scopes: strings, kind: { enum: ['user', 'agent'] }, authenticated: { type: 'boolean' } },
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
  ext: { produces: [] },
  create: (options, ctx) => createRulesAuthorization(options, ctx.name, ctx.stack ? () => ctx.stack?.().vocabularies : undefined),
});

export const adapters = [adapter];
