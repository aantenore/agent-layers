import type { AdapterRef, CallContext, Identity, Stack } from '@agent-layers/core';
import { UsageError } from './io.ts';
import type { Project } from './project.ts';

export const TOKEN_ENV = 'AGENT_LAYERS_TOKEN';

/**
 * Credential the CLI presents as the caller: `--token`, then AGENT_LAYERS_TOKEN, then, for prototype-tier profiles only,
 * the first token of the static-identity adapter in the identity slot.
 */
export function resolveToken(p: Pick<Project, 'config' | 'env'>, flag?: string): string | undefined {
  const given = flag || p.env[TOKEN_ENV];
  if (given) return given;
  if (p.config.tier !== 'prototype') return undefined;
  const ref = p.config.layers.identity as AdapterRef | null | undefined;
  if (ref?.adapter !== 'static-identity') return undefined;
  const tokens = ref.options?.tokens;
  return tokens && typeof tokens === 'object' ? Object.keys(tokens)[0] : undefined;
}

/**
 * Verifies the caller's credential through the identity slot. Anonymous (undefined) when the stack has no identity
 * port or no credential is available; a credential that does not verify ends the command. The token is never printed.
 */
export async function authenticate(stack: Stack, p: Pick<Project, 'config' | 'env'>, flag?: string): Promise<Identity | undefined> {
  if (!stack.ports.identity) return undefined;
  const token = resolveToken(p, flag);
  if (!token) return undefined;
  try {
    return await stack.verify(token);
  } catch {
    throw new UsageError(`the credential was rejected by the identity adapter (check --token or ${TOKEN_ENV})`);
  }
}

/** Run context for the authenticated caller. */
export const callerContext = (identity: Identity | undefined): Partial<CallContext> => (identity ? { identity } : {});
