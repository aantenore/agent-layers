import {
  compose, defineAdapter, noMappings, PORT_VERSIONS, recordingTelemetry, resolveProfile, type ApprovalPort, type GuardPort, type Stack, type StackConfig, type TelemetryRecord,
} from '@agent-layers/core';
import { adapter as functions, defineTool } from '@agent-layers/adapter-functions';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { adapter, type LoopOptions } from '../src/index.ts';

export const add = defineTool({
  name: 'add', description: 'Adds two numbers', risk: 'read',
  params: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] },
  run: async ({ a, b }) => `sum=${Number(a) + Number(b)}`,
});
export const save = defineTool({
  name: 'save', description: 'Saves a note', risk: 'write',
  params: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  run: async ({ text }) => `saved ${String(text)}`,
});

const rules = [
  { match: 'add (\\d+) and (\\d+)', tool: 'add', args: { a: '{{1}}', b: '{{2}}' } },
  { match: 'save (\\w+)', tool: 'save', args: { text: '{{1}}' } },
];

export function config(runtime: LoopOptions = {}, extra: Partial<StackConfig> = {}): StackConfig {
  return {
    layers: {
      model: { adapter: 'mock-model', options: { rules } },
      runtime: { adapter: 'basic-runtime', options: runtime as Record<string, unknown> },
      tools: { math: { adapter: 'functions' } },
      ...extra.layers,
    },
    agents: { calc: { instructions: 'You add numbers.', model: 'mock', tools: ['math__*'] } },
    ...(extra.policy ? { policy: extra.policy } : {}),
  };
}

/** Approval that leaves every request pending. */
export const pendingApproval = defineAdapter<'ApprovalPort'>({
  layer: 'identity', port: 'ApprovalPort', name: 'test-approval', direction: 'outbound', maps: { technology: 'test' },
  portVersion: PORT_VERSIONS.ApprovalPort, tiers: ['prototype'],
  create: (_o, ctx): ApprovalPort => {
    const open = (request: never) => ({ id: 'ap-1', status: 'pending' as const, request });
    return {
      name: ctx.name,
      request: async (request) => open(request as never),
      get: async () => undefined,
      decide: async () => { throw new Error('not used'); },
      wait: async (id) => ({ ...open(undefined as never), id }),
    };
  },
});

/** Guard that blocks any text containing "forbidden". */
export const blockingGuard = defineAdapter<'GuardPort'>({
  layer: 'guardrail', port: 'GuardPort', name: 'test-guard', direction: 'outbound', maps: { technology: 'test' },
  portVersion: PORT_VERSIONS.GuardPort, tiers: ['prototype'],
  create: (_o, ctx): GuardPort => ({
    name: ctx.name,
    stages: ['input'],
    check: async (input) => (input.text.includes('forbidden') ? { action: 'block', reason: 'secret internal text' } : { action: 'allow' }),
  }),
});

export async function stack(runtime: LoopOptions = {}, extra: Partial<StackConfig> = {}) {
  const records: TelemetryRecord[] = [];
  const math = { ...functions, create: () => functions.create({ tools: [add, save] }, { name: 'math', env: {}, cwd: process.cwd(), telemetry: undefined as never, mappings: noMappings() }) };
  const s = await compose(resolveProfile(config(runtime, extra)), {
    adapters: [mockModel, adapter, math, pendingApproval, blockingGuard], telemetry: [recordingTelemetry((r) => records.push(r))],
  });
  return { s, records };
}

export const spec = { name: 'a', instructions: '', model: 'm', tools: [] as string[] };

/** A model reply with one text part. */
export const reply = (text: string) => ({ model: 'm', finish: 'end', message: { role: 'assistant', parts: [{ type: 'text', text }] } });

/** A minimal stack around a scripted model and tools, for loop behaviour that needs no composition. */
export function fakeStack(parts: { model: object; tools?: object; approval?: string }): Stack {
  return {
    ports: { ...(parts.approval ? { approval: { name: parts.approval } } : {}) },
    context: (init: object) => ({ runId: 'r', ...init }),
    modelFor: () => parts.model,
    toolsFor: () => parts.tools ?? { listTools: async () => [], callTool: async () => ({ ok: true, text: 'ok' }) },
  } as never;
}
