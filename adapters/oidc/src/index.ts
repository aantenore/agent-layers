import { defineAdapter, PORT_VERSIONS } from '@agent-layers/core';
import { createOidcCredentials, type OidcCredentialsOptions } from './credentials.ts';
import { createOidcIdentity, type OidcIdentityOptions } from './identity.ts';
import { JWS_ALGORITHMS } from './jwt.ts';

export { createOidcIdentity, defaultKind, rolesOf, scopesOf, DEFAULT_ALGORITHMS } from './identity.ts';
export type { OidcIdentityHooks, OidcIdentityOptions, OidcIdentityPort } from './identity.ts';
export { createOidcCredentials, ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT } from './credentials.ts';
export type { OidcCredentialsHooks, OidcCredentialsOptions, OidcCredentialPort } from './credentials.ts';
export { OidcError, MAX_RESPONSE_BYTES, type FetchLike } from './http.ts';
export { JWS_ALGORITHMS, MAX_TOKEN_CHARS } from './jwt.ts';

const STANDARD = 'OpenID Connect / OAuth 2.0 (RFC 7519, RFC 8693)';
const strings = { type: 'array', items: { type: 'string', minLength: 1 } };
const url = { type: 'string', minLength: 1 };
const ms = { type: 'integer', minimum: 0 };

export const identityAdapter = defineAdapter<'IdentityPort', OidcIdentityOptions>({
  layer: 'identity',
  port: 'IdentityPort',
  name: 'oidc',
  direction: 'outbound',
  maps: { standard: STANDARD },
  portVersion: PORT_VERSIONS.IdentityPort,
  tiers: ['production'],
  description: 'Verifies JWT access tokens of any OpenID provider through discovery and JWKS.',
  optionsSchema: {
    type: 'object',
    properties: {
      issuer: url,
      audience: { anyOf: [{ type: 'string', minLength: 1 }, { ...strings, minItems: 1 }] },
      allowAnyAudience: { type: 'boolean' },
      jwksUri: url,
      algorithms: { type: 'array', items: { enum: Object.keys(JWS_ALGORITHMS) }, minItems: 1 },
      types: strings,
      clockSkewSec: { type: 'integer', minimum: 0, maximum: 600 },
      maxTokenAgeSec: { type: 'integer', minimum: 1 },
      jwksMinRefreshMs: ms,
      jwksMaxAgeMs: ms,
      timeoutMs: { type: 'integer', minimum: 1 },
      allowHttp: { type: 'boolean' },
      roleClients: strings,
    },
    required: ['issuer'],
    additionalProperties: false,
  },
  create: (options, ctx) => createOidcIdentity(options, {}, ctx.name),
});

export const credentialAdapter = defineAdapter<'CredentialPort', OidcCredentialsOptions>({
  layer: 'identity',
  port: 'CredentialPort',
  name: 'oidc',
  direction: 'outbound',
  maps: { standard: STANDARD },
  portVersion: PORT_VERSIONS.CredentialPort,
  tiers: ['production'],
  description: 'Outbound tokens from an OAuth 2 token endpoint: RFC 8693 token exchange on behalf of the caller, or client_credentials as the agent.',
  optionsSchema: {
    type: 'object',
    properties: {
      issuer: url,
      tokenEndpoint: url,
      clientId: { type: 'string', minLength: 1 },
      clientSecret: { type: 'string', minLength: 1 },
      mode: { enum: ['on-behalf-of', 'self'] },
      authMethod: { enum: ['client_secret_basic', 'client_secret_post'] },
      audienceParam: { enum: ['audience', 'resource', 'none'] },
      refreshSkewSec: { type: 'integer', minimum: 0 },
      defaultTtlSec: { type: 'integer', minimum: 1 },
      maxCacheEntries: { type: 'integer', minimum: 1 },
      timeoutMs: { type: 'integer', minimum: 1 },
      allowHttp: { type: 'boolean' },
    },
    required: ['clientId', 'clientSecret', 'mode'],
    additionalProperties: false,
  },
  create: (options, ctx) => createOidcCredentials(options, {}, ctx.name),
});

export const adapters = [identityAdapter, credentialAdapter];
