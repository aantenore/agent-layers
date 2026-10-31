import { defineAdapter, PORT_VERSIONS, type AuthorizationPort } from '@agent-layers/core';
import { PdpError, pdpRequest, postJson, reasonText, secureUrl, type FetchLike } from './pdp.ts';

export { PdpError, pdpRequest, reasonText, MAX_RESPONSE_BYTES, type FetchLike } from './pdp.ts';

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
  timeoutMs?: number;
  /** Accept a plain-HTTP URL on a non-loopback host (default false). */
  allowHttp?: boolean;
}

export const EVALUATION_PATH = '/access/v1/evaluation';

/**
 * AuthorizationPort over the OpenID AuthZEN Authorization API 1.0 access evaluation endpoint. Answers that are not a
 * boolean `decision` reject, which the stack treats as a deny. Only `reason` / `reason_user` reach the decision;
 * `reason_admin` stays with the PDP.
 */
export function createAuthzen(options: AuthzenOptions, hooks: { fetch?: FetchLike } = {}, name = 'authzen'): AuthorizationPort {
  if (!options?.url) throw new PdpError('authzen: "url" is required');
  const base = secureUrl(options.url, 'authzen url', options.allowHttp);
  const path = options.path ?? EVALUATION_PATH;
  if (!/^\/[\w\-./]*$/.test(path) || path.includes('..')) throw new PdpError('authzen: "path" must be an absolute path');
  const endpoint = new URL(`${base.pathname.replace(/\/+$/, '')}${path}`, base.origin).href;
  const fetchImpl = hooks.fetch ?? fetch;
  return {
    name,
    native: () => ({ endpoint }),
    async evaluate(req, opts) {
      const body = await postJson(fetchImpl, endpoint, pdpRequest(req, options.includeArgs === true), {
        ...(options.headers ? { headers: options.headers } : {}), timeoutMs: options.timeoutMs ?? 5000, what: 'AuthZEN', ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      if (typeof body.decision !== 'boolean') throw new PdpError('AuthZEN: the response has no boolean "decision"');
      const ctx = body.context && typeof body.context === 'object' ? (body.context as Record<string, unknown>) : {};
      const reason = reasonText(ctx.reason) ?? reasonText(ctx.reason_user);
      return { decision: body.decision, ...(reason ? { context: { reason } } : {}) };
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
      timeoutMs: { type: 'integer', minimum: 1 },
      allowHttp: { type: 'boolean' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  create: (options, ctx) => createAuthzen(options, {}, ctx.name),
});

export const adapters = [adapter];
