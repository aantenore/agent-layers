import type { AdapterRef, CallContext, Caller, Stack } from '@agent-layers/core';
import { UsageError } from './io.ts';
import type { Project } from './project.ts';

export const TOKEN_ENV = 'AGENT_LAYERS_TOKEN';

/**
 * Credential the CLI presents as the caller: `--token`, then AGENT_LAYERS_TOKEN, then, for prototype-tier profiles only,
 * the development credential of the identity adapter (its descriptor's `devCredential`, when it has one).
 */
export async function resolveToken(p: Pick<Project, 'config' | 'env' | 'registry'>, flag?: string): Promise<string | undefined> {
  const given = flag || p.env[TOKEN_ENV];
  if (given) return given;
  if (p.config.tier !== 'prototype') return undefined;
  const ref = p.config.layers.identity as AdapterRef | null | undefined;
  if (!ref?.adapter) return undefined;
  // An adapter that cannot be loaded offers no credential; check and compose report the load failure themselves.
  const descriptor = await p.registry.resolve('IdentityPort', ref.adapter).catch(() => undefined);
  const token = descriptor?.devCredential?.(ref.options ?? {});
  return typeof token === 'string' && token ? token : undefined;
}

/**
 * Verifies the caller's credential through the identity slot. Anonymous (undefined) when the stack has no identity
 * port or no credential is available; a credential that does not verify ends the command. The token is never printed.
 */
export async function authenticate(stack: Stack, p: Pick<Project, 'config' | 'env' | 'registry'>, flag?: string): Promise<Caller | undefined> {
  if (!stack.ports.identity) return undefined;
  const token = await resolveToken(p, flag);
  if (!token) return undefined;
  try {
    return await stack.verify(token);
  } catch {
    throw new UsageError(`the credential was rejected by the identity adapter (check --token or ${TOKEN_ENV})`);
  }
}

/** Run context for the authenticated caller. */
export const callerContext = (caller: Caller | undefined): Partial<CallContext> => (caller ? { caller } : {});

/** A stop reason as one line: `code`, then `by` and `detail` when present. */
export const reasonLine = (r: { code: string; by?: string; detail?: string } | undefined): string =>
  r ? [r.code, r.by && `by ${r.by}`, r.detail].filter(Boolean).join(' ') : '';
