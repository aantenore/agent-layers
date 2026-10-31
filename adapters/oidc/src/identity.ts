import type { Identity, IdentityPort } from '@agent-layers/core';
import { abortable, discover, OidcError, requestJson, secureUrl, type FetchLike } from './http.ts';
import { candidateKeys, checkAlgorithm, decodeJwt, importKey, verifySignature, type Jwk } from './jwt.ts';

export interface OidcIdentityOptions {
  /** Expected `iss`, exactly as the provider publishes it; also the discovery base URL. */
  issuer: string;
  /** Accepted `aud` value(s). Required unless `allowAnyAudience` is set. */
  audience?: string | string[];
  /** Accept tokens for any audience of the issuer (ID tokens and tokens for other services included). Default false. */
  allowAnyAudience?: boolean;
  /** Read keys from this URL instead of the discovery document. */
  jwksUri?: string;
  /** Accepted asymmetric algorithms (default RS256, ES256). `none` and `HS*` are always refused. */
  algorithms?: string[];
  /** Accepted `typ` header values, compared case-insensitively without `application/` (e.g. `at+jwt`). Off by default. */
  types?: string[];
  /** Tolerance for `exp`, `nbf` and `iat`, in seconds (default 60). */
  clockSkewSec?: number;
  /** Refuse tokens issued longer ago than this (`iat`, then required), in seconds. Off by default. */
  maxTokenAgeSec?: number;
  /** Minimum interval between JWKS fetches caused by an unknown `kid` or a failure (default 30 s). */
  jwksMinRefreshMs?: number;
  /** JWKS cache lifetime (default 10 min). The previous key set keeps serving while the provider is down. */
  jwksMaxAgeMs?: number;
  /** Timeout of discovery and JWKS requests (default 5 s). */
  timeoutMs?: number;
  /** Accept plain-HTTP issuer and JWKS URLs on non-loopback hosts (default false). */
  allowHttp?: boolean;
  /** Clients whose `resource_access` roles are included (default: all). */
  roleClients?: string[];
}

/** Code-only extensions: not part of the JSON options. */
export interface OidcIdentityHooks {
  /** Derives `Identity.kind` from the verified claims (default `defaultKind`). */
  kind?: (claims: Record<string, unknown>) => 'user' | 'agent';
  fetch?: FetchLike;
  /** Clock in milliseconds (tests). */
  now?: () => number;
}

export const DEFAULT_ALGORITHMS = ['RS256', 'ES256'];
/** Most keys tried for a token without a `kid`. */
const MAX_KEY_TRIES = 5;

const invalid = (why: string) => new OidcError('invalid_token', why);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A client-credentials token is the agent's own identity: the subject is the client itself (RFC 9068: `sub` equals
 * `client_id` / `azp`, or there is no `sub`) or the Keycloak service-account user of `azp`. Everything else is a user.
 */
export function defaultKind(claims: Record<string, unknown>): 'user' | 'agent' {
  const { sub, client_id, azp, preferred_username } = claims;
  if (sub === undefined) return 'agent';
  if (typeof sub === 'string' && (sub === client_id || sub === azp)) return 'agent';
  // Keycloak names the service-account user of client X `service-account-x`; the token's `azp` must be that client.
  if (typeof preferred_username === 'string' && typeof azp === 'string' && preferred_username.toLowerCase() === `service-account-${azp}`.toLowerCase()) return 'agent';
  return 'user';
}

/** Roles from Keycloak-style `realm_access` / `resource_access` and a plain `roles` claim, deduplicated. */
export function rolesOf(claims: Record<string, unknown>, roleClients?: readonly string[]): string[] {
  const out = new Set(strings((claims.realm_access as { roles?: unknown } | undefined)?.roles));
  const resources = claims.resource_access;
  if (resources && typeof resources === 'object' && !Array.isArray(resources)) {
    for (const [client, access] of Object.entries(resources as Record<string, { roles?: unknown } | null>)) {
      if (roleClients && !roleClients.includes(client)) continue;
      for (const r of strings(access?.roles)) out.add(r);
    }
  }
  for (const r of strings(claims.roles)) out.add(r);
  return [...out];
}

/** Scopes from `scope` (space separated, RFC 8693 / RFC 9068) and `scp` (array or string). */
export function scopesOf(claims: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const s of [...strings(claims.scope), ...strings(claims.scp)]) for (const part of s.split(' ')) if (part) out.add(part);
  return [...out];
}

const normType = (t: string) => t.toLowerCase().replace(/^application\//, '');

export type OidcIdentityPort = IdentityPort & { native(): { refresh(): Promise<void> } };

/**
 * IdentityPort over JWT access tokens of an OpenID provider. Keys come from discovery + JWKS (cached, refetched on an
 * unknown `kid` at most once per `jwksMinRefreshMs`, previous keys kept during an outage); the signature is checked
 * with node:crypto, then `iss`, `aud`, `exp`, `nbf` and `iat`.
 */
export function createOidcIdentity(opts: OidcIdentityOptions, hooks: OidcIdentityHooks = {}, name = 'oidc'): OidcIdentityPort {
  if (!opts?.issuer) throw new OidcError('config', 'oidc: "issuer" is required');
  secureUrl(opts.issuer, 'issuer', opts.allowHttp);
  if (opts.jwksUri) secureUrl(opts.jwksUri, 'jwksUri', opts.allowHttp);
  const audiences = opts.audience === undefined ? [] : strings(opts.audience).filter(Boolean);
  if (!audiences.length && !opts.allowAnyAudience) throw new OidcError('config', 'oidc: set "audience" (or "allowAnyAudience": true to accept any audience)');
  const algorithms = opts.algorithms?.length ? [...opts.algorithms] : DEFAULT_ALGORITHMS;
  for (const alg of algorithms) checkAlgorithm(alg, algorithms);
  const types = opts.types?.map(normType);
  const skew = opts.clockSkewSec ?? 60;
  const minRefresh = opts.jwksMinRefreshMs ?? 30_000;
  const maxAge = opts.jwksMaxAgeMs ?? 600_000;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const fetchImpl: FetchLike = hooks.fetch ?? fetch;
  const now = hooks.now ?? Date.now;
  const kindOf = hooks.kind ?? defaultKind;

  let keys: Jwk[] | undefined;
  let fetchedAt = 0;
  let lastAttempt = -Infinity;
  let lastError: unknown;
  let inflight: Promise<void> | undefined;
  let jwksUri = opts.jwksUri;

  const load = async () => {
    if (!jwksUri) {
      const doc = await discover(fetchImpl, opts.issuer, timeoutMs, opts.allowHttp);
      if (typeof doc.jwks_uri !== 'string') throw new OidcError('config', 'OIDC discovery: no "jwks_uri"');
      jwksUri = secureUrl(doc.jwks_uri, 'jwks_uri', opts.allowHttp).href;
    }
    const body = await requestJson(fetchImpl, jwksUri, { method: 'GET', timeoutMs, what: 'JWKS' });
    if (!Array.isArray(body.keys)) throw new OidcError('response', 'JWKS: no "keys" array');
    keys = (body.keys as unknown[]).filter((k): k is Jwk => !!k && typeof k === 'object' && !Array.isArray(k) && typeof (k as Jwk).kty === 'string');
    fetchedAt = now();
  };

  /** One fetch at a time; on failure the previous key set stays in use. */
  const refresh = (): Promise<void> => {
    inflight ??= (async () => {
      lastAttempt = now();
      try {
        await load();
        lastError = undefined;
      } catch (err) {
        lastError = err;
        if (!keys) throw err;
      }
    })().finally(() => { inflight = undefined; });
    return inflight;
  };

  const getKeys = async (unknownKid: boolean, signal?: AbortSignal): Promise<Jwk[]> => {
    const limited = now() - lastAttempt < minRefresh;
    if (!keys && limited && lastError) throw lastError;
    const stale = !keys || now() - fetchedAt > maxAge;
    if (!keys || (stale && !limited) || (unknownKid && !limited)) await abortable(refresh(), signal);
    return keys ?? [];
  };

  return {
    name,
    native: () => ({ refresh }),
    async verify(credential, vopts) {
      const jwt = decodeJwt(credential);
      const { alg, kid, crit, typ } = jwt.header;
      checkAlgorithm(alg, algorithms);
      if (crit !== undefined) throw invalid('token uses critical header parameters');
      if (types && (typeof typ !== 'string' || !types.includes(normType(typ)))) throw invalid('token type is not accepted');

      let candidates = candidateKeys(await getKeys(false, vopts?.signal), alg, kid);
      if (!candidates.length && kid !== undefined) candidates = candidateKeys(await getKeys(true, vopts?.signal), alg, kid);
      if (!candidates.length) throw invalid('no signing key matches the token');
      // A known kid never triggers a refetch on a bad signature; without a kid a few keys of the right type are tried.
      const tried = kid !== undefined ? candidates.slice(0, 1) : candidates.slice(0, MAX_KEY_TRIES);
      if (!tried.some((k) => verifySignature(jwt, importKey(k, alg)))) throw invalid('invalid token signature');

      const c = jwt.payload;
      const t = now() / 1000;
      if (c.iss !== opts.issuer) throw invalid('token issuer mismatch');
      if (audiences.length && !strings(c.aud).some((a) => audiences.includes(a))) throw invalid('token audience mismatch');
      if (!isNum(c.exp)) throw invalid('token has no "exp"');
      if (t > c.exp + skew) throw invalid('token expired');
      if (c.nbf !== undefined && (!isNum(c.nbf) || t + skew < c.nbf)) throw invalid('token not yet valid');
      if (c.iat !== undefined) {
        if (!isNum(c.iat) || c.iat > t + skew) throw invalid('token "iat" is in the future');
        if (opts.maxTokenAgeSec !== undefined && t - c.iat > opts.maxTokenAgeSec + skew) throw invalid('token too old');
      } else if (opts.maxTokenAgeSec !== undefined) throw invalid('token has no "iat"');

      const kind = kindOf(c);
      if (kind !== 'user' && kind !== 'agent') throw invalid('token kind cannot be determined');
      const subject = typeof c.sub === 'string' && c.sub
        ? c.sub
        : kind === 'agent' ? [c.client_id, c.azp].find((v): v is string => typeof v === 'string' && !!v) : undefined;
      if (!subject) throw invalid('token has no subject');
      const identity: Identity = { subject, kind, roles: rolesOf(c, opts.roleClients), scopes: scopesOf(c), claims: c, token: credential };
      return identity;
    },
  };
}
