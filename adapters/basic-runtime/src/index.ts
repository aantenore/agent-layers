import { defineAdapter, limitProperties, PORT_VERSIONS, type RunEvent, type RuntimePort } from '@agent-layers/core';
import { LIMITS, runLoop, type LoopOptions, type ModelPrice } from './loop.ts';

export { LIMITS, runLoop, type LoopOptions, type ModelPrice };

/** Factory: an in-process loop over the stack's model and tools. */
export function createBasicRuntime(options: LoopOptions = {}, name = 'basic-runtime'): RuntimePort {
  return {
    name,
    bind(stack, agent) {
      return {
        name: agent.name,
        async run(input, init = {}) {
          const ctx = stack.context({ ...init, agent: agent.name });
          const events: RunEvent[] = [];
          const it = runLoop(stack, agent, input, ctx, options);
          for (;;) {
            const step = await it.next();
            if (step.done) {
              events.push({ type: 'run_end', status: step.value.status, ...(step.value.reason ? { reason: step.value.reason } : {}), ...(step.value.costUsd !== undefined ? { costUsd: step.value.costUsd } : {}) });
              return { ...step.value, events };
            }
            events.push(step.value);
          }
        },
        async *stream(input, init = {}) {
          const ctx = stack.context({ ...init, agent: agent.name });
          const it = runLoop(stack, agent, input, ctx, options);
          for (;;) {
            const step = await it.next();
            if (step.done) {
              yield { type: 'run_end', status: step.value.status, output: step.value.output, usage: step.value.usage, ...(step.value.costUsd !== undefined ? { costUsd: step.value.costUsd } : {}), ...(step.value.reason ? { reason: step.value.reason } : {}) };
              return;
            }
            yield step.value;
          }
        },
      };
    },
  };
}

export const adapter = defineAdapter<'RuntimePort', LoopOptions>({
  layer: 'harness',
  port: 'RuntimePort',
  name: 'basic-runtime',
  direction: 'outbound',
  maps: { technology: 'in-process tool-calling loop' },
  portVersion: PORT_VERSIONS.RuntimePort,
  tiers: ['prototype'],
  description: 'Minimal agent loop: model call, tool calls, final answer. For development, tests and demos.',
  optionsSchema: {
    type: 'object',
    properties: {
      ...limitProperties(LIMITS, { maxTurns: 'Model calls per run' }),
      pricing: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: { inputPerMTok: { type: 'number', minimum: 0 }, outputPerMTok: { type: 'number', minimum: 0 } },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  limits: LIMITS,
  create: (options, ctx) => createBasicRuntime(options, ctx.name),
});

export const adapters = [adapter];
