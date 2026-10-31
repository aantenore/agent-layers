import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assembleDeltas, compose, ConfigError, defineAdapter, governedTools, GuardrailBlocked, parseArgs, PORT_VERSIONS, replyToDeltas, resolveProfile,
  stopReasonOf, type AdapterContext, type IdentityPort, type StackConfig,
} from '../src/index.ts';
import { ctx, recorder } from './helpers.ts';

const identityAdapter = (seen: { ctx?: AdapterContext }) => defineAdapter({
  layer: 'identity', port: 'IdentityPort', name: 'claims-id', direction: 'outbound', maps: { standard: 'test claims' },
  portVersion: PORT_VERSIONS.IdentityPort, tiers: ['prototype'], optionsSchema: { type: 'object' },
  ext: { namespace: 'claims', produces: ['claims.tenant'] },
  vocabularies: { risk: { add: { admin: { like: 'exec' } } } },
  mappingDefaults: { in: { shape: 'Caller', rules: [{ from: '/groups', to: '/roles' }] } },
  create: (_o, c): IdentityPort => {
    seen.ctx = c;
    return { verify: async (token) => c.mappings.in({ groups: ['g1'], tenant: 't1', sub: token }, { id: token, kind: 'user', roles: [], scopes: [] }) };
  },
});

const authAdapter = defineAdapter({
  layer: 'identity', port: 'AuthorizationPort', name: 'pdp', direction: 'outbound', maps: { standard: 'test pdp' },
  portVersion: PORT_VERSIONS.AuthorizationPort, tiers: ['prototype'], optionsSchema: { type: 'object' },
  ext: { reads: ['claims.tenant', 'ghost.key'] },
  mappingDefaults: { out: { shape: 'AccessQuestion' } },
  create: () => ({ evaluate: async () => ({ allowed: true }) }),
});

test('compose hands each instance its rules: defaults, appended config rules, ext writes in its namespace', async () => {
  const seen: { ctx?: AdapterContext } = {};
  const config: StackConfig = {
    layers: { identity: { adapter: 'claims-id' }, authorization: { adapter: 'pdp' } },
    mappings: {
      identity: { in: { $merge: 'append', items: [{ from: '/tenant', to: '/ext/claims.tenant' }] } },
      authorization: { out: [{ from: '/caller/ext/claims.tenant', to: '/subject/tenant' }] },
    },
    policy: [{ effect: 'deny', risk: ['admin'] }],
  };
  const s = await compose(resolveProfile(config), { adapters: [identityAdapter(seen), authAdapter] });
  assert.deepEqual(seen.ctx!.mappings.rules.in.length, 2);
  assert.deepEqual(await s.verify('u1'), { id: 'u1', kind: 'user', roles: ['g1'], scopes: [], ext: { 'claims.tenant': 't1' } });
  assert.ok(s.vocabularies.has('risk', 'admin'), 'adapter vocabulary additions are part of the stack');
  assert.deepEqual(s.warnings, ['authorization: adapter "pdp" reads ext key "ghost.key" that no adapter in the profile produces']);
  await s.close();
});

test('compose refuses rules it cannot honour, with every problem named', async () => {
  const seen = {};
  const config: StackConfig = {
    layers: { identity: { adapter: 'claims-id' }, authorization: { adapter: 'pdp' } },
    mappings: {
      identity: { in: [{ from: '/x', to: '/ext/other.key' }], out: [{ from: '/id', to: '/x' }] },
      authorization: { out: [{ from: '/caller/ext/nobody.key', to: '/x' }] },
      'tools.missing': { in: [] },
    },
    policy: [{ effect: 'deny', risk: ['root'] }],
  };
  await assert.rejects(compose(resolveProfile(config), { adapters: [identityAdapter(seen), authAdapter] }), (e: unknown) => {
    assert.ok(e instanceof ConfigError);
    assert.deepEqual(e.errors, [
      'mappings.tools.missing: no adapter instance with this key in the profile (known: identity, authorization)',
      `mappings.identity.in[0].to: ext key "other.key" is outside the adapter's namespace "claims"`,
      'mappings.identity.out: adapter "claims-id" takes no out mappings',
      'mappings.authorization.out: reads ext key "nobody.key" that no adapter in the profile produces',
      'policy[0].risk: "root" is not a risk value (add it under vocabularies.risk)',
    ]);
    return true;
  });
});

test('descriptors are checked: ext namespace and produces, vocabularies, mapping defaults', () => {
  const base = { layer: 'cache', port: 'CachePort', name: 'c', direction: 'outbound', maps: { technology: 'x' }, portVersion: PORT_VERSIONS.CachePort, tiers: ['prototype'], create: () => ({}) } as const;
  assert.throws(() => defineAdapter({ ...base, ext: { produces: ['other.key', 'bare'] } } as never), /must be in the namespace "c"/);
  assert.throws(() => defineAdapter({ ...base, ext: { namespace: 'sdk' } } as never), /reserved/);
  assert.throws(() => defineAdapter({ ...base, vocabularies: { layer: { add: { x: { like: 'llm' } } } } } as never), /is closed/);
  assert.throws(() => defineAdapter({ ...base, mappingDefaults: { in: { shape: 'Nope' } } } as never), /unknown shape/);
  assert.throws(() => defineAdapter({ ...base, mappingDefaults: { in: { shape: 'ToolSpec', rules: [{ from: '/a', to: '/nope' }] } } } as never), /no field "nope"/);
});

test('oversized ext bags are dropped where the core passes shapes on, with an event', async () => {
  const { records, telemetry } = recorder();
  const big = { 'x.blob': 'y'.repeat(400) };
  const tools = governedTools({ t: { listTools: async () => [{ name: 'a', description: 'a', params: {}, risk: 'read', ext: big }], callTool: async () => ({ ok: true, text: 'r', ext: big }) } }, { telemetry, extBytes: 256 });
  const [spec] = await tools.listTools(ctx());
  assert.equal(spec!.ext, undefined);
  const out = await tools.callTool('t__a', {}, ctx());
  assert.deepEqual(out.ext, { 'sdk.outcome': 'ok' });
  assert.equal(records.filter((r) => r.type === 'event' && r.name === 'agent.ext.dropped').length, 2);
});

test('deltas and replies: reasoning, calls with object args, invalid args kept, finish invariant', () => {
  assert.deepEqual(parseArgs('{"a":1}'), { args: { a: 1 } });
  assert.deepEqual(parseArgs('[1]'), { args: {}, invalid: '[1]' });
  const reply = assembleDeltas([
    { type: 'reasoning', text: 'think ' }, { type: 'reasoning', text: 'more' },
    { type: 'text', text: 'Hi' },
    { type: 'call', index: 0, id: 'c1', tool: 'get_', argsText: '{"q":' }, { type: 'call', index: 0, tool: 'time', argsText: '"x"}' },
    { type: 'call', index: 1, id: 'c2', tool: 'bad', argsText: '{oops' },
    { type: 'end', finish: 'end', usage: { inputTokens: 1, outputTokens: 2 } },
  ], 'm');
  assert.deepEqual(reply, {
    model: 'm', finish: 'tools', usage: { inputTokens: 1, outputTokens: 2 },
    message: { role: 'assistant', parts: [
      { type: 'reasoning', text: 'think more' }, { type: 'text', text: 'Hi' },
      { type: 'call', id: 'c1', tool: 'get_time', args: { q: 'x' } }, { type: 'call', id: 'c2', tool: 'bad', args: {}, invalid: '{oops' },
    ] },
  });
  assert.deepEqual(assembleDeltas(replyToDeltas(reply)), reply, 'reply → deltas → reply is lossless');
  assert.equal(assembleDeltas([{ type: 'text', text: 'x' }]).finish, 'other', 'no end delta: other');
});

test('stop reasons are structured; error text never becomes the reason', () => {
  assert.deepEqual(stopReasonOf(new GuardrailBlocked('pii', 'output', 'found an email')), { code: 'guard_block', layer: 'guardrail', by: 'pii', stage: 'output' });
  assert.deepEqual(stopReasonOf(Object.assign(new Error('x'), { name: 'AbortError' })), { code: 'aborted' });
  assert.deepEqual(stopReasonOf(Object.assign(new Error('x'), { name: 'TimeoutError' })), { code: 'timeout' });
  assert.deepEqual(stopReasonOf(new Error('token sk-123 leaked')), { code: 'error', detail: 'Error' });
});
