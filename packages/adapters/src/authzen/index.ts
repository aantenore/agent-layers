import { defineAdapter, limitProperties, limitValue, noMappings, PORT_VERSIONS, type AuthorizationPort, type LimitValue, type Mappings } from '@agent-layers/core';
import { LIMITS } from './limits.ts';
import { authzenRequest, PdpError, postJson, publicQuestion, reasonText, secureUrl, type FetchLike } from './pdp.ts';

export { authzenRequest, PdpError, publicQuestion, reasonText, type AuthzenRequest, type FetchLike } from './pdp.ts';
export { LIMITS } from './limits.ts';

export interface AuthzenOptions {
  /** Base URL of the PDP; requests go to `<url>/access/v1/evaluation`. */
  url: string;
  /** Overrides the evaluation path (default `/access/v1/evaluation`). */
  path?: string;
  /** Extra request headers, e.g. a PDP API key written as `${secret:...}` in the config. */
  headers?: Record<string, string>;
  /** Send the tool-call arguments in `context.args` (default false: arguments stay inside the stack). */
  includeArgs?: boolean;
  /** Request timeout (default 5 s). */
  timeoutMs?: LimitValue;
  /** Largest decision document read (default 1000000 bytes). */
  maxResponseBytes?: LimitValue;
  /** Longest reason passed on to the stack, in characters; the model sees it (default 200). */
  maxReasonChars?: number;
  /** Accept a plain-HTTP URL on a non-loopback host (default false). */
  allowHttp?: boolean;
}

export const EVALUATION_PATH = '/access/v1/evaluation';

/** Decision `context` keys other than the reasons, kept for the stack. */
export const CONTEXT_KEY = 'authzen.context';
const REASON_KEYS = new Set(['reason', 'reason_user', 'reason_admin']);

export interface AuthzenHooks {
  fetch?: FetchLike;
  /** Boundary mappings (`out` rules on the AccessQuestion, applied to the AuthZEN request). Default: none. */
  mappings?: Mappings;
}

/**
 * AuthorizationPort over the OpenID AuthZEN Authorization API 1.0 access evaluation endpoint. The question is sent in
 * AuthZEN names (`subject`, `action`, `resource`, `context.args`), then through the `out` mappings. Answers that are
 * not a boolean `decision` and mapping errors reject, which the stack treats as a deny. `reason` / `reason_user`
 * become the decision's reason, the other `context` keys `ext["authzen.context"]`; `reason_admin` stays with the PDP.
 */
export function createAuthzen(options: AuthzenOptions, hooks: AuthzenHooks = {}, name = 'authzen'): AuthorizationPort {
  if (!options?.url) throw new PdpError('authzen: "url" is required');
  const base = secureUrl(options.url, 'authzen url', options.allowHttp);
  const path = options.path ?? EVALUATION_PATH;
  if (!/^\/[\w\-./]*$/.test(path) || path.includes('..')) throw new PdpError('authzen: "path" must be an absolute path');
  const endpoint = new URL(`${base.pathname.replace(/\/+$/, '')}${path}`, base.origin).href;
  const fetchImpl = hooks.fetch ?? fetch;
  const timeoutMs = limitValue(LIMITS.timeoutMs, options.timeoutMs);
  const maxResponseBytes = limitValue(LIMITS.maxResponseBytes, options.maxResponseBytes);
  const maxReasonChars = limitValue(LIMITS.maxReasonChars, options.maxReasonChars);
  const mappings = hooks.mappings ?? noMappings(name);
  return {
    name,
    native: () => ({ endpoint }),
    async evaluate(q, opts) {
      const question = publicQuestion(q, options.includeArgs === true);
      const wire = mappings.out(question, authzenRequest(question));
      const body = await postJson(fetchImpl, endpoint, wire, {
        ...(options.headers ? { headers: options.headers } : {}), timeoutMs, maxResponseBytes, what: 'AuthZEN', ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      if (typeof body.decision !== 'boolean') throw new PdpError('AuthZEN: the response has no boolean "decision"');
      const ctx = body.context && typeof body.context === 'object' && !Array.isArray(body.context) ? (body.context as Record<string, unknown>) : {};
      const reason = reasonText(ctx.reason, maxReasonChars) ?? reasonText(ctx.reason_user, maxReasonChars);
      const rest = Object.fromEntries(Object.entries(ctx).filter(([k]) => !REASON_KEYS.has(k)));
      return { allowed: body.decision, ...(reason ? { reason } : {}), ...(Object.keys(rest).length ? { ext: { [CONTEXT_KEY]: rest } } : {}) };
    },
  };
}

export const adapter = defineAdapter<'AuthorizationPort', AuthzenOptions>({
  layer: 'identity',
  port: 'AuthorizationPort',
  name: 'authzen',
  direction: 'outbound',
  maps: { standard: 'OpenID AuthZEN' },
  portVersion: PORT_VERSIONS.AuthorizationPort,
  tiers: ['production'],
  description: 'Asks any OpenID AuthZEN policy decision point whether a tool call is allowed. Fails closed.',
  optionsSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1 },
      path: { type: 'string', pattern: '^/' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      includeArgs: { type: 'boolean' },
      allowHttp: { type: 'boolean' },
      ...limitProperties(LIMITS, { timeoutMs: 'Time limit per request', maxResponseBytes: 'Largest decision document read', maxReasonChars: 'Longest reason passed on to the stack' }),
    },
    required: ['url'],
    additionalProperties: false,
  },
  limits: LIMITS,
  ext: { produces: [CONTEXT_KEY] },
  mappingDefaults: { out: { shape: 'AccessQuestion' } },
  create: (options, ctx) => createAuthzen(options, { mappings: ctx.mappings }, ctx.name),
});

export const adapters = [adapter];
