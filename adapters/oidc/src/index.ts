import { defineAdapter, limitProperties, PORT_VERSIONS } from '@agent-layers/core';
import { createOidcCredentials, type OidcCredentialsOptions } from './credentials.ts';
import { CALLER_RULES, CLAIMS_KEY, createOidcIdentity, EXP_KEY, type OidcIdentityOptions } from './identity.ts';
import { JWS_ALGORITHMS } from './jwt.ts';
import { CREDENTIAL_LIMITS, IDENTITY_LIMITS } from './limits.ts';

export { agentKind, CALLER_RULES, CLAIMS_KEY, clientOf, clientRolesOf, createOidcIdentity, DEFAULT_ALGORITHMS, EXP_KEY, type AgentClients } from './identity.ts';
export type { OidcIdentityHooks, OidcIdentityOptions, OidcIdentityPort } from './identity.ts';
export { createOidcCredentials, ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE_GRANT } from './credentials.ts';
export type { OidcCredentialsHooks, OidcCredentialsOptions, OidcCredentialPort } from './credentials.ts';
export { OidcError, type FetchLike } from './http.ts';
export { JWS_ALGORITHMS } from './jwt.ts';
export { CREDENTIAL_LIMITS, IDENTITY_LIMITS } from './limits.ts';

const STANDARD = 'OpenID Connect / OAuth 2.0 (RFC 7519, RFC 8693)';
const strings = { type: 'array', items: { type: 'string', minLength: 1 } };
const url = { type: 'string', minLength: 1 };

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
      maxTokenAgeSec: { type: 'integer', minimum: 1 },
      allowHttp: { type: 'boolean' },
      agentClients: strings,
      agentSubjects: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } },
      roleClients: strings,
      namespaceClientRoles: { type: 'boolean' },
      keepClaims: { type: 'boolean' },
      ...limitProperties(IDENTITY_LIMITS, {
        clockSkewSec: 'Tolerance for exp, nbf and iat', jwksMinRefreshMs: 'Minimum interval between key set fetches after an unknown kid or a failure',
        jwksMaxAgeMs: 'Key set cache lifetime', timeoutMs: 'Time limit per discovery or key set request', maxKeyTries: 'Most keys tried for a token without a kid',
        maxTokenChars: 'Longest token accepted', maxResponseBytes: 'Largest discovery or key set document read',
        errorDescriptionChars: 'Characters of a provider error description kept in an error message',
      }),
    },
    required: ['issuer'],
    additionalProperties: false,
  },
  limits: IDENTITY_LIMITS,
  ext: { produces: [CLAIMS_KEY, EXP_KEY] },
  mappingDefaults: { in: { shape: 'Caller', rules: CALLER_RULES } },
  create: (options, ctx) => createOidcIdentity(options, { mappings: ctx.mappings }, ctx.name),
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
      allowHttp: { type: 'boolean' },
      ...limitProperties(CREDENTIAL_LIMITS, {
        refreshSkewSec: 'Renew a cached token this long before it expires', defaultTtlSec: 'Lifetime assumed when the response gives none',
        maxCacheEntries: 'Most tokens cached at once', timeoutMs: 'Time limit per token or discovery request',
        maxTokenChars: 'Longest token read for its expiry', maxResponseBytes: 'Largest discovery or token response read',
        errorDescriptionChars: 'Characters of a provider error description kept in an error message',
      }),
    },
    required: ['clientId', 'clientSecret', 'mode'],
    additionalProperties: false,
  },
  limits: CREDENTIAL_LIMITS,
  ext: { produces: [] },
  create: (options, ctx) => createOidcCredentials(options, {}, ctx.name),
});

export const adapters = [identityAdapter, credentialAdapter];
