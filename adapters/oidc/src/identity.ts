import { limitValue, type Identity, type IdentityPort, type LimitValue } from '@agent-layers/core';
import { abortable, discover, OidcError, requestJson, secureUrl, type FetchLike, type HttpLimits } from './http.ts';
import { candidateKeys, checkAlgorithm, decodeJwt, importKey, verifySignature, type Jwk } from './jwt.ts';
import { IDENTITY_LIMITS as LIMITS } from './limits.ts';

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
  timeoutMs?: LimitValue;
  /** Most keys tried for a token without a `kid` (default 5). */
  maxKeyTries?: number;
  /** Longest compact JWT accepted, in characters (default 16384). */
  maxTokenChars?: LimitValue;
  /** Largest discovery or JWKS document read (default 1000000 bytes). */
  maxResponseBytes?: LimitValue;
  /** Characters of a provider `error_description` kept in an error message (default 200). */
  errorDescriptionChars?: number;
  /** Accept plain-HTTP issuer and JWKS URLs on non-loopback hosts (default false). */
  allowHttp?: boolean;
  /**
   * Clients whose tokens may be the agent's own identity (client credentials). Without it no token is ever `agent`.
   * A token is `agent` only when its `azp` (or `client_id`) is listed and it has no `sub`, or its `sub` is the client
   * itself (RFC 9068) or, when set in `agentSubjects`, that client's service-account subject.
   */
  agentClients?: string[];
  /** Client → `sub` of its service account (Keycloak: the service-account user id). Replaces the `sub == client` rule. */
  agentSubjects?: Record<string, string>;
  /** Clients whose `resource_access` roles are included (default: the `audience` values). Other clients are never read. */
  roleClients?: string[];
  /** Client roles as `<client>:<role>`, so they cannot collide with realm roles (default true). */
  namespaceClientRoles?: boolean;
}

/** Code-only extensions: not part of the JSON options. */
export interface OidcIdentityHooks {
  /** Derives `Identity.kind` from the verified claims (default `agentKind` with `agentClients` / `agentSubjects`). */
  kind?: (claims: Record<string, unknown>) => 'user' | 'agent';
  fetch?: FetchLike;
  /** Clock in milliseconds (tests). */
  now?: () => number;
}

export const DEFAULT_ALGORITHMS = ['RS256', 'ES256'];

const invalid = (why: string) => new OidcError('invalid_token', why);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The client a token was issued to: `azp`, else `client_id`; none when both are set and differ. */
export function clientOf(claims: Record<string, unknown>): string | undefined {
  const azp = str(claims.azp);
  const clientId = str(claims.client_id);
  if (azp && clientId && azp !== clientId) return undefined;
  return azp ?? clientId;
}

export interface AgentClients { agentClients?: readonly string[]; agentSubjects?: Readonly<Record<string, string>> }

/**
 * `agent` only for a client-credentials token of an allow-listed client: no `sub`, or `sub` equal to the client's
 * configured service-account subject (or, when none is configured, to the client id, as in RFC 9068). Names chosen by
 * users (`preferred_username` and the like) never count. Everything else is `user`.
 */
export function agentKind(claims: Record<string, unknown>, cfg: AgentClients = {}): 'user' | 'agent' {
  const client = clientOf(claims);
  if (!client || !cfg.agentClients?.includes(client)) return 'user';
  const { sub } = claims;
  if (sub === undefined) return 'agent';
  const expected = cfg.agentSubjects && Object.hasOwn(cfg.agentSubjects, client) ? cfg.agentSubjects[client] : undefined;
  return sub === (expected ?? client) ? 'agent' : 'user';
}

/**
 * Roles: `realm_access.roles`, the issuer-set `roles` claim, and `resource_access` roles of the listed clients only,
 * as `<client>:<role>` unless `namespace` is false. Deduplicated.
 */
export function rolesOf(claims: Record<string, unknown>, clients: readonly string[] = [], namespace = true): string[] {
  const out = new Set(strings((claims.realm_access as { roles?: unknown } | undefined)?.roles));
  for (const r of strings(claims.roles)) out.add(r);
  const resources = claims.resource_access;
  if (resources && typeof resources === 'object' && !Array.isArray(resources)) {
    for (const client of clients) {
      if (!Object.hasOwn(resources, client)) continue;
      const access = (resources as Record<string, { roles?: unknown } | null>)[client];
      for (const r of strings(access?.roles)) out.add(namespace ? `${client}:${r}` : r);
    }
  }
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
  const skew = limitValue(LIMITS.clockSkewSec, opts.clockSkewSec);
  const minRefresh = limitValue(LIMITS.jwksMinRefreshMs, opts.jwksMinRefreshMs);
  const maxAge = limitValue(LIMITS.jwksMaxAgeMs, opts.jwksMaxAgeMs);
  const maxKeyTries = limitValue(LIMITS.maxKeyTries, opts.maxKeyTries);
  const maxTokenChars = limitValue(LIMITS.maxTokenChars, opts.maxTokenChars);
  const http: HttpLimits = {
    timeoutMs: limitValue(LIMITS.timeoutMs, opts.timeoutMs),
    maxResponseBytes: limitValue(LIMITS.maxResponseBytes, opts.maxResponseBytes),
    errorDescriptionChars: limitValue(LIMITS.errorDescriptionChars, opts.errorDescriptionChars),
  };
  const fetchImpl: FetchLike = hooks.fetch ?? fetch;
  const now = hooks.now ?? Date.now;
  const agents: AgentClients = { ...(opts.agentClients ? { agentClients: [...opts.agentClients] } : {}), ...(opts.agentSubjects ? { agentSubjects: { ...opts.agentSubjects } } : {}) };
  const kindOf = hooks.kind ?? ((c: Record<string, unknown>) => agentKind(c, agents));
  const roleClients = opts.roleClients ? [...opts.roleClients] : audiences;
  const namespaceRoles = opts.namespaceClientRoles ?? true;

  let keys: Jwk[] | undefined;
  let fetchedAt = 0;
  let lastAttempt = -Infinity;
  let lastError: unknown;
  let inflight: Promise<void> | undefined;
  let jwksUri = opts.jwksUri;

  const load = async () => {
    if (!jwksUri) {
      const doc = await discover(fetchImpl, opts.issuer, http, opts.allowHttp);
      if (typeof doc.jwks_uri !== 'string') throw new OidcError('config', 'OIDC discovery: no "jwks_uri"');
      jwksUri = secureUrl(doc.jwks_uri, 'jwks_uri', opts.allowHttp).href;
    }
    const body = await requestJson(fetchImpl, jwksUri, { method: 'GET', ...http, what: 'JWKS' });
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
      const jwt = decodeJwt(credential, maxTokenChars);
      const { alg, kid, crit, typ } = jwt.header;
      checkAlgorithm(alg, algorithms);
      if (crit !== undefined) throw invalid('token uses critical header parameters');
      if (types && (typeof typ !== 'string' || !types.includes(normType(typ)))) throw invalid('token type is not accepted');

      let candidates = candidateKeys(await getKeys(false, vopts?.signal), alg, kid);
      if (!candidates.length && kid !== undefined) candidates = candidateKeys(await getKeys(true, vopts?.signal), alg, kid);
      if (!candidates.length) throw invalid('no signing key matches the token');
      // A known kid never triggers a refetch on a bad signature; without a kid a few keys of the right type are tried.
      const tried = kid !== undefined ? candidates.slice(0, 1) : candidates.slice(0, maxKeyTries);
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
      // A token without `sub` names no one unless it is an allow-listed agent client.
      const subject = c.sub !== undefined ? str(c.sub) : kind === 'agent' ? clientOf(c) : undefined;
      if (!subject) throw invalid('token has no subject');
      const identity: Identity = { subject, kind, roles: rolesOf(c, roleClients, namespaceRoles), scopes: scopesOf(c), claims: c, token: credential };
      return identity;
    },
  };
}
