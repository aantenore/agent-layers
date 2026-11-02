import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallContext } from '@agent-layers/core';

export const ctx = (over: Partial<CallContext> = {}): CallContext => ({ runId: 'run-1', agent: 'agent-1', ...over });

/** Writes modules into a fresh temp dir (they cannot import workspace packages from there, so they export plain objects). */
export async function tempModules(files: Record<string, string>): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'functions-'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export const ADD_MODULE = `
export const tools = [
  {
    name: 'add',
    description: 'Add two numbers',
    risk: 'read',
    params: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false },
    run: ({ a, b }) => String(a + b),
  },
  {
    name: 'boom',
    description: 'Always fails',
    params: { type: 'object' },
    run: () => { throw new Error('kaboom'); },
  },
];
`;
