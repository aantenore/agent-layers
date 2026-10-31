import { defineAdapter, limitProperties, PORT_VERSIONS } from '@agent-layers/core';
import { createA2ARuntime, RUNTIME_LIMITS, type A2ARuntimeOptions } from './client.ts';
import { createA2AServerChannel, SERVER_LIMITS, type A2AServerOptions } from './server.ts';

export { isPrivateHost } from './client.ts';
export { createA2ARuntime, createA2AServerChannel, RUNTIME_LIMITS, SERVER_LIMITS, type A2ARuntimeOptions, type A2AServerOptions };
export { A2A_VERSION, LEGACY_VERSION, partsText, readResult, stateOf, type TaskState, type WireVersion } from './wire.ts';

const strings = { type: 'array', items: { type: 'string', minLength: 1 } };

/** Inbound: the stack's agents served over A2A, mounted by the gateway. */
export const channelAdapter = defineAdapter<'ChannelPort', A2AServerOptions>({
  layer: 'interface',
  port: 'ChannelPort',
  name: 'a2a',
  direction: 'inbound',
  maps: { standard: 'Agent2Agent (A2A) protocol' },
  portVersion: PORT_VERSIONS.ChannelPort,
  tiers: ['prototype', 'production'],
  description: 'Serves the stack\'s agents over A2A 1.0 (and 0.3): agent cards, SendMessage, SendStreamingMessage, GetTask, CancelTask.',
  optionsSchema: {
    type: 'object',
    properties: {
      basePath: { type: 'string', pattern: '^/' },
      agents: strings,
      defaultAgent: { type: 'string', minLength: 1 },
      descriptions: { type: 'object', additionalProperties: { type: 'string' } },
      version: { type: 'string', minLength: 1 },
      provider: {
        type: 'object',
        properties: { organization: { type: 'string', minLength: 1 }, url: { type: 'string', minLength: 1 } },
        required: ['organization', 'url'],
        additionalProperties: false,
      },
      ...limitProperties(SERVER_LIMITS, {
        maxTasksPerCaller: 'Tasks kept per authenticated caller, and of all anonymous callers together',
        maxTasks: 'Tasks kept in total',
        taskTtlMs: 'How long a finished task stays readable with GetTask',
      }),
    },
    additionalProperties: false,
  },
  limits: SERVER_LIMITS,
  create: (options, ctx) => createA2AServerChannel(options, ctx.name),
});

/** Outbound: a remote A2A agent, in any language, as the runtime of the stack. */
export const runtimeAdapter = defineAdapter<'RuntimePort', A2ARuntimeOptions>({
  layer: 'harness',
  port: 'RuntimePort',
  name: 'a2a',
  direction: 'outbound',
  maps: { standard: 'Agent2Agent (A2A) protocol' },
  portVersion: PORT_VERSIONS.RuntimePort,
  tiers: ['prototype', 'production'],
  description: 'Runs each agent call as a message to a remote A2A agent, with the caller\'s identity as a bearer token.',
  optionsSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', pattern: '^https?://' },
      endpoint: { type: 'string', pattern: '^https?://' },
      allowedEndpoints: { type: 'array', items: { type: 'string', pattern: '^https?://' } },
      allowHttp: { type: 'boolean' },
      version: { enum: ['1.0', '0.3'] },
      auth: {
        type: 'object',
        properties: { audience: { type: 'string', minLength: 1 }, scopes: strings },
        required: ['audience'],
        additionalProperties: false,
      },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      ...limitProperties(RUNTIME_LIMITS, {
        timeoutMs: 'Time limit of a whole run, polling included',
        pollMs: 'Interval between GetTask calls while a task is still working',
      }),
    },
    required: ['url'],
    additionalProperties: false,
  },
  limits: RUNTIME_LIMITS,
  // `a2a.state`: the remote task state the adapter does not know (the run is then failed).
  ext: { produces: ['a2a.state'] },
  mappingDefaults: { in: { shape: 'RunResult' } },
  create: (options, ctx) => createA2ARuntime(options, ctx.name, ctx.mappings),
});

export const adapters = [channelAdapter, runtimeAdapter];
