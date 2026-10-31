import { GUARD_STAGES } from './ports/guard.ts';
import { LAYERS } from './layers.ts';
import { limitSchema } from './limits.ts';
import type { JsonSchema } from './schema.ts';
import { SLOTS } from './slots.ts';
import { CHECK_LIMITS, GATEWAY_LIMITS, PIPELINE_LIMITS } from './stack-limits.ts';

/** Schema of a stack-config limit: a number, `"unbounded"` where allowed, or a `${env:NAME}` reference. */
const lim = (spec: Parameters<typeof limitSchema>[0], description: string) => limitSchema(spec, { env: true, description });

const ref: JsonSchema = {
  type: 'object',
  required: ['adapter'],
  properties: {
    adapter: { type: 'string', minLength: 1, description: 'Adapter name; resolved from the registry or the package @agent-layers/adapter-<name>.' },
    name: { type: 'string', description: 'Instance name for list slots.' },
    options: { type: 'object', description: 'Validated against the adapter optionsSchema.' },
    stages: { type: 'array', items: { enum: [...GUARD_STAGES] }, description: 'Guardrails only: stages this guard runs at.' },
  },
  additionalProperties: false,
};

/** In a profile, a single or keyed entry may omit `adapter` to change only the options of the inherited one. */
const refOverlay: JsonSchema = { ...ref, required: [] };

const append: JsonSchema = {
  type: 'object',
  required: ['$merge', 'items'],
  properties: { $merge: { const: 'append' }, items: { type: 'array', items: { $ref: '#/$defs/adapterRef' } } },
  additionalProperties: false,
};

const slotSchema = (shape: string, entry: string): JsonSchema =>
  shape === 'single' ? { anyOf: [{ $ref: entry }, { type: 'null' }] }
    : shape === 'map' ? { type: ['object', 'null'], additionalProperties: { anyOf: [{ $ref: entry }, { type: 'null' }] } }
      : { anyOf: [{ type: 'array', items: { $ref: '#/$defs/adapterRef' } }, { $ref: '#/$defs/append' }, { type: 'null' }] };

const layersSchema = (entry: string, description: string): JsonSchema => ({
  type: 'object',
  description,
  properties: Object.fromEntries([
    ...SLOTS.map((s) => [s.slot, { ...slotSchema(s.shape, entry), description: `${s.port} (${s.layer})` }]),
    ['services', { type: 'array', items: { type: 'object' }, description: 'Extra services for the deploy slot.' }],
  ]),
  additionalProperties: false,
});

const layers = layersSchema('#/$defs/adapterRef', 'One entry per slot; each slot fills one port.');
const layersOverlay = layersSchema('#/$defs/adapterRefOverlay', 'Only the slots that differ from the extended profile; null removes a slot.');

const policyRule: JsonSchema = {
  type: 'object',
  required: ['effect'],
  properties: {
    effect: { enum: ['allow', 'ask', 'deny'] },
    tools: { type: 'array', items: { type: 'string' } },
    risk: { type: 'array', items: { enum: ['read', 'write', 'exec'] } },
    when: {
      type: 'object',
      properties: {
        roles: { type: 'array', items: { type: 'string' } },
        scopes: { type: 'array', items: { type: 'string' } },
        kind: { enum: ['user', 'agent'] },
        authenticated: { type: 'boolean', description: 'true: any verified caller; false: only an anonymous caller.' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const pipeline: JsonSchema = {
  type: 'object',
  properties: {
    knowledge: {
      type: 'object',
      properties: {
        k: lim(PIPELINE_LIMITS.k, 'Passages injected per model call, and the default k of the search tools'),
        maxChars: lim(PIPELINE_LIMITS.maxChars, 'Size of the injected knowledge block'),
        maxK: lim(PIPELINE_LIMITS.maxK, 'Largest k a model may ask the knowledge search tools for'),
        mode: { enum: ['system', 'user', 'tools', 'off'], description: 'system/user: inject before model calls; tools: expose as tools; off.' },
      },
      additionalProperties: false,
    },
    cacheTtlMs: lim(PIPELINE_LIMITS.cacheTtlMs, 'Lifetime of cached model answers'),
    approvalTimeoutMs: lim(PIPELINE_LIMITS.approvalTimeoutMs, 'How long a tool call waits for a human approval; 0 does not wait'),
  },
  additionalProperties: false,
};

const gateway: JsonSchema = {
  type: 'object',
  description: 'Network host of the stack (agent-layers gateway).',
  properties: {
    port: { type: 'integer', minimum: 0, maximum: 65535 },
    host: { type: 'string', minLength: 1 },
    inbound: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Channel and trigger instance names to mount; every mountable one when omitted.' },
    anonymous: { type: 'boolean', description: 'Accept requests without a credential (default false).' },
    maxBodyBytes: lim(GATEWAY_LIMITS.maxBodyBytes, 'Largest accepted request body (413 above)'),
    requestTimeoutMs: lim(GATEWAY_LIMITS.requestTimeoutMs, 'Time limit of one request, streams included (504)'),
    headersTimeoutMs: lim(GATEWAY_LIMITS.headersTimeoutMs, 'Time a client has to send the request headers'),
    bodyTimeoutMs: lim(GATEWAY_LIMITS.bodyTimeoutMs, 'Time a client has to send the whole request; capped by requestTimeoutMs'),
    closeGraceMs: lim(GATEWAY_LIMITS.closeGraceMs, 'How long shutdown waits for requests and trigger runs in flight'),
    corsMaxAgeS: lim(GATEWAY_LIMITS.corsMaxAgeS, 'How long browsers may cache a CORS preflight answer'),
    maxRequestIdChars: lim(GATEWAY_LIMITS.maxRequestIdChars, 'Longest X-Request-Id kept from the caller; longer ones are replaced'),
    publicOrigin: { type: 'string', minLength: 1 },
    allowedOrigins: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Origins accepted besides the gateway\'s own; other Origin headers get 403.' },
    allowedHosts: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Accepted Host names (name or name:port); default: loopback names when bound to loopback.' },
    cors: {
      type: 'object',
      properties: { origins: { type: 'array', items: { type: 'string', minLength: 1 } } },
      required: ['origins'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const limits: JsonSchema = {
  type: 'object',
  description: 'Limits that belong to no single layer. Gateway limits are in `gateway`, pipeline limits in `pipeline`, adapter limits in their options.',
  properties: {
    check: {
      type: 'object',
      description: 'agent-layers check: time limits of the conformance probes.',
      properties: {
        timeoutMs: lim(CHECK_LIMITS.timeoutMs, 'Time limit of one conformance probe'),
        deployTimeoutMs: lim(CHECK_LIMITS.deployTimeoutMs, 'Time limit of the deploy probes (up, down)'),
        listToolsTimeoutMs: lim(CHECK_LIMITS.listToolsTimeoutMs, 'Time limit of listing tools to find a probe audience'),
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const agent: JsonSchema = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Markdown agent file: front matter (model, tools, knowledge) and instructions as body.' },
    instructions: { type: 'string' },
    model: { type: 'string' },
    tools: { type: 'array', items: { type: 'string' } },
    knowledge: { type: 'array', items: { type: 'string' } },
    params: { type: 'object' },
  },
  additionalProperties: false,
};

const profile: JsonSchema = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    extends: { type: 'string' },
    tier: { enum: ['prototype', 'production'] },
    requires: { type: 'array', items: { enum: SLOTS.map((s) => s.slot) } },
    layers: { $ref: '#/$defs/layersOverlay' },
    policy: { type: 'array', items: { $ref: '#/$defs/policyRule' } },
    pipeline: { $ref: '#/$defs/pipeline' },
    gateway: { $ref: '#/$defs/gateway' },
    limits: { $ref: '#/$defs/limits' },
  },
  additionalProperties: false,
};

/** JSON Schema of agent-layers.json. */
export const configSchema: JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/aantenore/agent-layers/spec/schemas/stack-config.json',
  title: 'StackConfig',
  description: `Stack configuration: which adapter fills each port, per profile. Layers: ${LAYERS.map((l) => l.layer).join(", ")}.`,
  type: 'object',
  properties: {
    $schema: { type: 'string' },
    name: { type: 'string' },
    plugins: { type: 'array', items: { type: 'string' }, description: 'Modules exporting adapter descriptors.' },
    profile: { type: 'string', description: 'Default profile.' },
    layers: { $ref: '#/$defs/layers' },
    policy: { type: 'array', items: { $ref: '#/$defs/policyRule' } },
    pipeline: { $ref: '#/$defs/pipeline' },
    gateway: { $ref: '#/$defs/gateway' },
    limits: { $ref: '#/$defs/limits' },
    profiles: { type: 'object', additionalProperties: { $ref: '#/$defs/profile' } },
    agents: { type: 'object', additionalProperties: { $ref: '#/$defs/agent' } },
  },
  additionalProperties: false,
  $defs: { adapterRef: ref, adapterRefOverlay: refOverlay, append, layers, layersOverlay, policyRule, pipeline, gateway, limits, agent, profile },
};
