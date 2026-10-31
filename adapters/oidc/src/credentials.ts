import { createHash } from 'node:crypto';
import { limitValue, type Caller, type CredentialPort, type LimitValue } from '@agent-layers/core';
import { abortable, discover, OidcError, requestJson, secureUrl, type FetchLike, type HttpLimits } from './http.ts';
import { EXP_KEY } from './identity.ts';
import { unverifiedExpiry } from './jwt.ts';
import { CREDENTIAL_LIMITS as LIMITS } from './limits.ts';

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';

export interface OidcCredentialsOptions {
  /** Issuer used to discover `token_endpoint`; or set `tokenEndpoint`. */
  issuer?: string;
  tokenEndpoint?: string;
  clientId: string;
  clientSecret: string;
  /** `on-behalf-of`: RFC 8693 token exchange of the caller's token. `self`: client_credentials, the agent's own identity. */
  mode: 'on-behalf-of' | 'self';
  /** Client authentication at the token endpoint (default `client_secret_basic`). */
  authMethod?: 'client_secret_basic' | 'client_secret_post';
  /** How the audience is sent: `audience` (RFC 8693; Keycloak, Auth0), `resource` (RFC 8707) or not at all. */
  audienceParam?: 'audience' | 'resource' | 'none';
  /** Cached tokens are reused until this many seconds before they expire (default 30). */
  refreshSkewSec?: number;
  /** Lifetime assumed when the response has no `expires_in` and the token is not a JWT (default 60 s). */
  defaultTtlSec?: number;
  /** Most tokens cached at once (default 1000). */
  maxCacheEntries?: LimitValue;
  /** Timeout of token requests (default 10 s). */
  timeoutMs?: LimitValue;
  /** Longest compact JWT read for its expiry, in characters (default 16384). */
  maxTokenChars?: LimitValue;
  /** Largest discovery or token response read (default 1000000 bytes). */
  maxResponseBytes?: LimitValue;
  /** Characters of a provider `error_description` kept in an error message (default 200). */
  errorDescriptionChars?: number;
  /** Accept plain-HTTP URLs on non-loopback hosts (default false). */
  allowHttp?: boolean;
}

export interface OidcCredentialsHooks {
  fetch?: FetchLike;
  now?: () => number;
}

interface Cached { token: string; expiresAt: number }

const formEncode = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
const sha = (s: string) => createHash('sha256').update(s).digest('base64url');

function expiresInSec(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Expiry of the caller's credential in seconds: the earlier of the verified `exp` (`ext["oidc.exp"]`, written by the
 * oidc identity adapter) and the credential's own unverified `exp` when it is a JWT.
 */
function callerExpiry(caller: Caller, maxTokenChars: number): number | undefined {
  const verified = caller.ext?.[EXP_KEY];
  const unverified = unverifiedExpiry(caller.credential!, maxTokenChars);
  const values = [verified, unverified].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return values.length ? Math.min(...values) : undefined;
}

export type OidcCredentialPort = CredentialPort & { native(): { clear(): void } };

/**
 * CredentialPort over an OAuth 2 token endpoint. Tokens are cached per (audience, scopes, caller token) until shortly
 * before they expire; an on-behalf-of token is never cached past the caller's own token. Identical concurrent requests
 * share one call to the token endpoint.
 */
export function createOidcCredentials(opts: OidcCredentialsOptions, hooks: OidcCredentialsHooks = {}, name = 'oidc'): OidcCredentialPort {
  if (!opts?.clientId || !opts.clientSecret) throw new OidcError('config', 'oidc credentials: "clientId" and "clientSecret" are required');
  if (opts.mode !== 'on-behalf-of' && opts.mode !== 'self') throw new OidcError('config', 'oidc credentials: "mode" must be "on-behalf-of" or "self"');
  if (!opts.tokenEndpoint && !opts.issuer) throw new OidcError('config', 'oidc credentials: set "issuer" or "tokenEndpoint"');
  if (opts.tokenEndpoint) secureUrl(opts.tokenEndpoint, 'tokenEndpoint', opts.allowHttp);
  else secureUrl(opts.issuer!, 'issuer', opts.allowHttp);
  const fetchImpl: FetchLike = hooks.fetch ?? fetch;
  const now = hooks.now ?? Date.now;
  const http: HttpLimits = {
    timeoutMs: limitValue(LIMITS.timeoutMs, opts.timeoutMs),
    maxResponseBytes: limitValue(LIMITS.maxResponseBytes, opts.maxResponseBytes),
    errorDescriptionChars: limitValue(LIMITS.errorDescriptionChars, opts.errorDescriptionChars),
  };
  const maxTokenChars = limitValue(LIMITS.maxTokenChars, opts.maxTokenChars);
  const defaultTtlSec = limitValue(LIMITS.defaultTtlSec, opts.defaultTtlSec);
  const skewMs = limitValue(LIMITS.refreshSkewSec, opts.refreshSkewSec) * 1000;
  const maxEntries = Math.max(1, limitValue(LIMITS.maxCacheEntries, opts.maxCacheEntries));
  const audienceParam = opts.audienceParam ?? 'audience';
  const cache = new Map<string, Cached>();
  const inflight = new Map<string, Promise<string>>();
  let endpoint: Promise<string> | undefined = opts.tokenEndpoint ? Promise.resolve(opts.tokenEndpoint) : undefined;

  const tokenEndpoint = () => {
    if (!endpoint) {
      const p = discover(fetchImpl, opts.issuer!, http, opts.allowHttp).then((doc) => {
        if (typeof doc.token_endpoint !== 'string') throw new OidcError('config', 'OIDC discovery: no "token_endpoint"');
        return secureUrl(doc.token_endpoint, 'token_endpoint', opts.allowHttp).href;
      });
      p.catch(() => { if (endpoint === p) endpoint = undefined; }); // discovery is retried on the next request
      endpoint = p;
    }
    return endpoint;
  };

  const remember = (key: string, entry: Cached) => {
    cache.delete(key);
    if (cache.size >= maxEntries) {
      const t = now();
      for (const [k, v] of cache) if (v.expiresAt <= t) cache.delete(k);
      while (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
    }
    cache.set(key, entry);
  };

  const request = async (params: Record<string, string>): Promise<{ token: string; expiresIn?: number }> => {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    const body = new URLSearchParams(params);
    if ((opts.authMethod ?? 'client_secret_basic') === 'client_secret_basic') {
      // RFC 6749 §2.3.1: id and secret are form-encoded before base64.
      headers.authorization = `Basic ${Buffer.from(`${formEncode(opts.clientId)}:${formEncode(opts.clientSecret)}`).toString('base64')}`;
    } else {
      body.set('client_id', opts.clientId);
      body.set('client_secret', opts.clientSecret);
    }
    const exchange = params.grant_type === TOKEN_EXCHANGE_GRANT;
    const what = exchange ? 'token exchange' : 'client credentials';
    const res = await requestJson(fetchImpl, await tokenEndpoint(), { method: 'POST', headers, body: body.toString(), ...http, what });
    const token = res.access_token;
    if (typeof token !== 'string' || !token || /\s/.test(token)) throw new OidcError('response', `${what}: no valid access_token in the response`);
    const type = typeof res.token_type === 'string' ? res.token_type.toLowerCase() : undefined;
    if (type && type !== 'bearer' && type !== 'n_a') throw new OidcError('response', `${what}: unsupported token_type`);
    if (exchange && res.issued_token_type !== undefined && res.issued_token_type !== ACCESS_TOKEN_TYPE && res.issued_token_type !== JWT_TOKEN_TYPE) {
      throw new OidcError('response', `${what}: unexpected issued_token_type`);
    }
    const expiresIn = expiresInSec(res.expires_in);
    return { token, ...(expiresIn !== undefined ? { expiresIn } : {}) };
  };

  return {
    name,
    requiresCaller: opts.mode === 'on-behalf-of',
    native: () => ({ clear: () => cache.clear() }),
    async close() { cache.clear(); },
    async token(audience, topts = {}) {
      if (typeof audience !== 'string' || !audience) throw new OidcError('credentials', 'oidc credentials: audience is required');
      const scopes = [...new Set(topts.scopes ?? [])].filter(Boolean).sort();
      const caller = topts.caller;
      let subjectKey = 'self';
      let subjectExpMs = Infinity;
      if (opts.mode === 'on-behalf-of') {
        // Never fall back to the agent's own token: a call without a caller credential gets no token at all.
        if (typeof caller?.credential !== 'string' || !caller.credential) throw new OidcError('credentials', 'oidc credentials: on-behalf-of needs the caller credential, and the run has none');
        const exp = callerExpiry(caller, maxTokenChars);
        if (exp !== undefined) {
          subjectExpMs = exp * 1000;
          if (subjectExpMs <= now()) throw new OidcError('credentials', 'oidc credentials: the caller token has expired');
        }
        subjectKey = `obo:${sha(caller.credential)}`;
      }
      const key = JSON.stringify([audience, scopes, subjectKey]);
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return hit.token;
      if (hit) cache.delete(key);

      let pending = inflight.get(key);
      if (!pending) {
        const params: Record<string, string> = opts.mode === 'self'
          ? { grant_type: 'client_credentials' }
          : { grant_type: TOKEN_EXCHANGE_GRANT, subject_token: caller!.credential!, subject_token_type: ACCESS_TOKEN_TYPE, requested_token_type: ACCESS_TOKEN_TYPE };
        if (audienceParam !== 'none') params[audienceParam] = audience;
        if (scopes.length) params.scope = scopes.join(' ');
        // Shared by every identical caller, so it does not use any caller's signal; each caller races its own.
        const p = (async () => {
          const { token, expiresIn } = await request(params);
          const issuedExpMs = expiresIn !== undefined ? now() + expiresIn * 1000 : (unverifiedExpiry(token, maxTokenChars) ?? now() / 1000 + defaultTtlSec) * 1000;
          const expiresAt = Math.min(issuedExpMs, subjectExpMs) - skewMs;
          if (expiresAt > now()) remember(key, { token, expiresAt });
          return token;
        })().finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
        inflight.set(key, p);
        pending = p;
      }
      return abortable(pending, topts.signal);
    },
  };
}
