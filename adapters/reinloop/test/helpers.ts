import {
  compose, defineAdapter, type AgentConfig, type AnyAdapter, noMappings, PORT_VERSIONS, recordingTelemetry, resolveProfile, type ApprovalPort, type CallContext, type GuardPort, type ModelPort, type ModelReply,
  type ModelRequest, type StackConfig, type TelemetryRecord,
} from '@agent-layers/core';
import { adapter as functions, defineTool } from '@agent-layers/adapter-functions';
import { adapter as mockModel } from '@agent-layers/adapter-mock-model';
import { adapter, type ReinloopOptions } from '../src/index.ts';

export const seen: { caller?: string; signal?: boolean }[] = [];

export const add = defineTool({
  name: 'add', description: 'Adds two numbers', risk: 'read',
  params: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] },
  run: async ({ a, b }, ctx: CallContext) => {
    seen.push({ ...(ctx.caller ? { caller: ctx.caller.id } : {}), signal: !!ctx.signal });
    return `sum=${Number(a) + Number(b)}`;
  },
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

export function config(runtime: ReinloopOptions = {}, extra: Partial<StackConfig> = {}, agent: Partial<AgentConfig> = {}): StackConfig {
  return {
    layers: {
      model: { adapter: 'mock-model', options: { rules } },
      runtime: { adapter: 'reinloop', options: runtime as Record<string, unknown> },
      tools: { math: { adapter: 'functions' } },
      ...extra.layers,
    },
    agents: { calc: { instructions: 'You add numbers.', model: 'mock', tools: ['math__*'], ...agent } },
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

/** Model that answers from a script and records the requests it received. */
export function scriptedModel(replies: (ModelReply | Error)[]) {
  const requests: ModelRequest[] = [];
  const adapterOf = defineAdapter<'ModelPort'>({
    layer: 'llm', port: 'ModelPort', name: 'test-script', direction: 'outbound', maps: { technology: 'test' },
    portVersion: PORT_VERSIONS.ModelPort, tiers: ['prototype'],
    create: (_o, ctx): ModelPort => ({
      name: ctx.name,
      chat: async (req) => {
        requests.push(structuredClone(req));
        const next = replies.shift();
        if (!next) throw new Error('script exhausted');
        if (next instanceof Error) throw next;
        return next;
      },
    }),
  });
  return { adapter: adapterOf, requests };
}

export const textReply = (text: string, finish = 'end'): ModelReply => ({ model: 'scripted', finish, message: { role: 'assistant', parts: [{ type: 'text', text }] }, usage: { inputTokens: 3, outputTokens: 2 } });

export async function stack(runtime: ReinloopOptions = {}, extra: Partial<StackConfig> = {}, opts: { adapters?: AnyAdapter[]; agent?: Partial<AgentConfig> } = {}) {
  const records: TelemetryRecord[] = [];
  const math = { ...functions, create: () => functions.create({ tools: [add, save] }, { name: 'math', env: {}, cwd: process.cwd(), telemetry: undefined as never, mappings: noMappings() }) };
  const s = await compose(resolveProfile(config(runtime, extra, opts.agent)), {
    adapters: [mockModel, adapter, math, pendingApproval, blockingGuard, ...(opts.adapters ?? [])], telemetry: [recordingTelemetry((r) => records.push(r))],
  });
  return { s, records, spans: (name: string) => records.filter((r) => r.type === 'span' && r.name === name) };
}
