import { defineAdapter, PORT_VERSIONS, type Caller, type CredentialPort, type IdentityPort } from '@agent-layers/core';

/** One caller of the table. `subject` becomes `Caller.id`; `claims` are kept under `ext["static-identity.claims"]`. */
export interface TokenEntry {
  subject: string;
  kind?: 'user' | 'agent';
  roles?: string[];
  scopes?: string[];
  /** Display name (`Caller.name`). */
  name?: string;
  claims?: Record<string, unknown>;
}

export const CLAIMS_KEY = 'static-identity.claims';

export interface StaticIdentityOptions {
  /** Credential → caller. */
  tokens: Record<string, TokenEntry>;
}

export interface StaticCredentialOptions {
  /** Audience → token. */
  tokens?: Record<string, string>;
  /** Token for any audience not listed in `tokens`. */
  default?: string;
}

const DEV_ONLY = 'Development only: never use with real credentials.';

/** Identity port over a fixed credential table. The credential is never echoed in errors. */
export function createStaticIdentity(options: StaticIdentityOptions, name = 'static-identity'): IdentityPort {
  const table = new Map(Object.entries(options.tokens ?? {}));
  return {
    name,
    async verify(credential) {
      const entry = credential ? table.get(credential) : undefined;
      if (!entry) throw new Error('invalid credential');
      const caller: Caller = { id: entry.subject, kind: entry.kind ?? 'user', roles: [...entry.roles ?? []], scopes: [...entry.scopes ?? []], credential };
      if (entry.name) caller.name = entry.name;
      if (entry.claims) caller.ext = { [CLAIMS_KEY]: structuredClone(entry.claims) };
      return caller;
    },
  };
}

/** Credential port over a fixed audience → token table. */
export function createStaticCredentials(options: StaticCredentialOptions = {}, name = 'static-identity'): CredentialPort {
  const table = new Map(Object.entries(options.tokens ?? {}));
  return {
    name,
    async token(audience) {
      const token = table.get(audience) ?? options.default;
      if (!token) throw new Error(`no token for audience ${audience}`);
      return token;
    },
  };
}

const strings = { type: 'array', items: { type: 'string' } };

export const identityAdapter = defineAdapter<'IdentityPort', StaticIdentityOptions>({
  layer: 'identity',
  port: 'IdentityPort',
  name: 'static-identity',
  direction: 'outbound',
  maps: { technology: 'static token table (development only)' },
  portVersion: PORT_VERSIONS.IdentityPort,
  tiers: ['prototype'],
  description: `Verifies credentials against a fixed table. ${DEV_ONLY}`,
  optionsSchema: {
    type: 'object',
    properties: {
      tokens: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: {
            subject: { type: 'string', minLength: 1 },
            kind: { enum: ['user', 'agent'] },
            roles: strings,
            scopes: strings,
            name: { type: 'string', minLength: 1 },
            claims: { type: 'object' },
          },
          required: ['subject'],
          additionalProperties: false,
        },
      },
    },
    required: ['tokens'],
    additionalProperties: false,
  },
  ext: { produces: [CLAIMS_KEY] },
  create: (options, ctx) => createStaticIdentity(options, ctx.name),
});

export const credentialAdapter = defineAdapter<'CredentialPort', StaticCredentialOptions>({
  layer: 'identity',
  port: 'CredentialPort',
  name: 'static-identity',
  direction: 'outbound',
  maps: { technology: 'static token table (development only)' },
  portVersion: PORT_VERSIONS.CredentialPort,
  tiers: ['prototype'],
  description: `Hands out fixed tokens per audience. ${DEV_ONLY}`,
  optionsSchema: {
    type: 'object',
    properties: {
      tokens: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } },
      default: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
  ext: { produces: [] },
  create: (options, ctx) => createStaticCredentials(options, ctx.name),
});

export const adapters = [identityAdapter, credentialAdapter];
