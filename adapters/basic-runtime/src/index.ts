import { defineAdapter, limitProperties, PORT_VERSIONS, type RunEvent, type RunResult, type RuntimePort } from '@agent-layers/core';
import { LIMITS, runLoop, type LoopOptions, type ModelPrice } from './loop.ts';

export { LIMITS, runLoop, type LoopOptions, type ModelPrice };

/** The core `run.end` event of a result. */
const endEvent = (r: RunResult): RunEvent => ({
  type: 'run.end', status: r.status, ...(r.reason ? { reason: r.reason } : {}), ...(r.usage ? { usage: r.usage } : {}), ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
});

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
              events.push(endEvent(step.value));
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
              yield endEvent(step.value);
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
  ext: { reads: ['sdk.approval'] },
  create: (options, ctx) => createBasicRuntime(options, ctx.name),
});

export const adapters = [adapter];
