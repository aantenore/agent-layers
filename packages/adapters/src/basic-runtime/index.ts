import { defineAdapter, limitProperties, PORT_VERSIONS, RunRefused, type RunEvent, type RunResult, type RuntimePort } from '@agent-layers/core';
import { asCheckpoint, LIMITS, runLoop, type LoopCheckpoint, type LoopOptions, type ModelPrice } from './loop.ts';

export { asCheckpoint, LIMITS, runLoop, type LoopCheckpoint, type LoopOptions, type ModelPrice };

/** The core `run.end` event of a result, with the checkpoint of a waiting run. */
const endEvent = (r: RunResult): RunEvent => ({
  type: 'run.end', status: r.status, ...(r.reason ? { reason: r.reason } : {}), ...(r.usage ? { usage: r.usage } : {}), ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
  ...(r.checkpoint !== undefined ? { checkpoint: r.checkpoint } : {}),
});

/** The run.end event as recorded in a result's events: the checkpoint stays on the result only. */
const recordedEnd = (r: RunResult): RunEvent => {
  const { checkpoint: _checkpoint, ...end } = endEvent(r) as Extract<RunEvent, { type: 'run.end' }>;
  return end;
};

/** Factory: an in-process loop over the stack's model and tools. */
export function createBasicRuntime(options: LoopOptions = {}, name = 'basic-runtime'): RuntimePort {
  return {
    name,
    bind(stack, agent) {
      const collect = async (it: AsyncGenerator<RunEvent, RunResult>): Promise<RunResult> => {
        const events: RunEvent[] = [];
        for (;;) {
          const step = await it.next();
          if (step.done) {
            events.push(recordedEnd(step.value));
            return { ...step.value, events };
          }
          events.push(step.value);
        }
      };
      return {
        name: agent.name,
        run: (input, init = {}) => collect(runLoop(stack, agent, input, stack.context({ ...init, agent: agent.name }), options)),
        /** Runs exactly the call that waited (it finds its decision through the stack's tools), then goes on. */
        async resume(checkpoint, answer, init = {}) {
          const from: LoopCheckpoint | undefined = asCheckpoint(checkpoint);
          if (!from) throw new RunRefused('invalid', 'not a checkpoint of this runtime');
          const ctx = stack.context({ ...init, agent: agent.name });
          return collect(runLoop(stack, agent, '', ctx, options, { checkpoint: from, ...('input' in answer ? { input: answer.input } : {}) }));
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
