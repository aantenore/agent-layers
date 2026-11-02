import { defineAdapter, limitProperties, limitValue, noMappings, PORT_VERSIONS, type AuthorizationPort, type LimitValue, type Mappings } from '@agent-layers/core';
import { LIMITS } from './limits.ts';
import { PdpError, postJson, publicQuestion, reasonText, secureUrl, type FetchLike } from './http.ts';

export { PdpError, publicQuestion, reasonText, type FetchLike } from './http.ts';
export { LIMITS } from './limits.ts';

export interface OpaOptions {
  /** Base URL of the OPA server. */
  url: string;
  /** Policy path under `/v1/data` (default `agents/decision`). */
  path?: string;
  /** Extra request headers, e.g. `authorization` for an OPA started with `--authentication=token`. */
  headers?: Record<string, string>;
  /** Send the tool-call arguments in `input.args` (default false: arguments stay inside the stack). */
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

export const DEFAULT_PATH = 'agents/decision';
const PATH = /^[A-Za-z_][\w-]*(\/[A-Za-z_][\w-]*)*$/;

export interface OpaHooks {
  fetch?: FetchLike;
  /** Boundary mappings (`out` rules on the AccessQuestion, applied to the input). Default: none. */
  mappings?: Mappings;
}

/**
 * AuthorizationPort over OPA's Data API: `POST <url>/v1/data/<path>` with `{ input: AccessQuestion }` in language
 * names (`input.caller.roles`, `input.target.risk`), after the `out` mappings. The rule must evaluate to a boolean or
 * to `{ allow: boolean, reason?: string }`; anything else, an undefined rule and a failing mapping included, rejects,
 * which the stack treats as a deny.
 */
export function createOpa(options: OpaOptions, hooks: OpaHooks = {}, name = 'opa'): AuthorizationPort {
  if (!options?.url) throw new PdpError('opa: "url" is required');
  const base = secureUrl(options.url, 'opa url', options.allowHttp);
  const path = (options.path ?? DEFAULT_PATH).replace(/^\/+|\/+$/g, '');
  if (!PATH.test(path)) throw new PdpError('opa: "path" must look like "package/rule"');
  const endpoint = new URL(`${base.pathname.replace(/\/+$/, '')}/v1/data/${path}`, base.origin).href;
  const rule = `data.${path.replaceAll('/', '.')}`;
  const fetchImpl = hooks.fetch ?? fetch;
  const timeoutMs = limitValue(LIMITS.timeoutMs, options.timeoutMs);
  const maxResponseBytes = limitValue(LIMITS.maxResponseBytes, options.maxResponseBytes);
  const maxReasonChars = limitValue(LIMITS.maxReasonChars, options.maxReasonChars);
  const mappings = hooks.mappings ?? noMappings(name);
  return {
    name,
    native: () => ({ endpoint, rule }),
    async evaluate(q, opts) {
      const question = publicQuestion(q, options.includeArgs === true);
      const input = mappings.out(question, question);
      const body = await postJson(fetchImpl, endpoint, { input }, {
        ...(options.headers ? { headers: options.headers } : {}), timeoutMs, maxResponseBytes, what: 'OPA', ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      const result = body.result;
      if (typeof result === 'boolean') return { allowed: result };
      if (result && typeof result === 'object' && !Array.isArray(result) && typeof (result as { allow?: unknown }).allow === 'boolean') {
        const r = result as { allow: boolean; reason?: unknown };
        const reason = reasonText(r.reason, maxReasonChars);
        return { allowed: r.allow, ...(reason ? { reason } : {}) };
      }
      throw new PdpError(`OPA: ${rule} is ${result === undefined ? 'undefined' : 'not a boolean decision'}`);
    },
  };
}

export const adapter = defineAdapter<'AuthorizationPort', OpaOptions>({
  layer: 'identity',
  port: 'AuthorizationPort',
  name: 'opa',
  direction: 'outbound',
  maps: { technology: 'Open Policy Agent' },
  portVersion: PORT_VERSIONS.AuthorizationPort,
  tiers: ['production'],
  description: 'Asks Open Policy Agent (Data API) whether a tool call is allowed. Fails closed.',
  optionsSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1 },
      path: { type: 'string', minLength: 1 },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      includeArgs: { type: 'boolean' },
      allowHttp: { type: 'boolean' },
      ...limitProperties(LIMITS, { timeoutMs: 'Time limit per request', maxResponseBytes: 'Largest decision document read', maxReasonChars: 'Longest reason passed on to the stack' }),
    },
    required: ['url'],
    additionalProperties: false,
  },
  limits: LIMITS,
  ext: { produces: [] },
  mappingDefaults: { out: { shape: 'AccessQuestion' } },
  create: (options, ctx) => createOpa(options, { mappings: ctx.mappings }, ctx.name),
});

export const adapters = [adapter];
