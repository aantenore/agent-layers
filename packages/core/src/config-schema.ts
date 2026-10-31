import { GUARD_STAGES } from './ports/guard.ts';
import { LAYERS } from './layers.ts';
import type { JsonSchema } from './schema.ts';
import { SLOTS } from './slots.ts';

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
        k: { type: 'integer', minimum: 1 },
        maxChars: { type: 'integer', minimum: 200 },
        mode: { enum: ['system', 'user', 'tools', 'off'], description: 'system/user: inject before model calls; tools: expose as tools; off.' },
      },
      additionalProperties: false,
    },
    cacheTtlMs: { type: 'integer', minimum: 0 },
    approvalTimeoutMs: { type: 'integer', minimum: 0 },
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
    profiles: { type: 'object', additionalProperties: { $ref: '#/$defs/profile' } },
    agents: { type: 'object', additionalProperties: { $ref: '#/$defs/agent' } },
  },
  additionalProperties: false,
  $defs: { adapterRef: ref, adapterRefOverlay: refOverlay, append, layers, layersOverlay, policyRule, pipeline, agent, profile },
};
