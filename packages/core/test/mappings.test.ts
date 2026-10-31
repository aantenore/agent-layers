import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applyRules, createMappings, effectiveRules, extReads, getPointer, loadMappingFunctions, MappingError, mappingsProblems, mergeMappings,
  rulesAgainstShape, setPointer, Vocabularies, type MappingRule,
} from '../src/index.ts';

const run = (rules: MappingRule[], source: unknown, target: unknown = {}) => applyRules(rules, source, target, { key: 'k', direction: 'in' });

test('pointers: RFC 6901 escapes, lists, creation on write', () => {
  const doc = { a: { 'b/c': [1, { 'd~e': 2 }] } };
  assert.equal(getPointer(doc, '/a/b~1c/1/d~0e'), 2);
  assert.equal(getPointer(doc, '/a/missing/x'), undefined);
  assert.deepEqual(setPointer({}, '/x/y', 1), { x: { y: 1 } });
  assert.deepEqual(setPointer({ l: [1] }, '/l/-', 2), { l: [1, 2] });
  assert.throws(() => setPointer({}, '/__proto__/x', 1), /forbidden/);
});

test('every rule kind: copy, default, map, join union, join string, split, drop, rename, constant', () => {
  const source = { a: 'x', n: null, flag: true, r1: ['admin', 'user'], r2: ['user', 'ops'], scope: 'read write  ', parts: ['a', 'b'] };
  assert.deepEqual(run([{ from: '/a', to: '/copy' }], source), { copy: 'x' });
  assert.deepEqual(run([{ from: '/n', to: '/d', default: 'dflt' }, { from: '/none', to: '/e', default: 0 }], source), { d: 'dflt', e: 0 });
  assert.deepEqual(run([{ from: '/none', to: '/skip' }], source), {}, 'missing and no default: no write');
  assert.deepEqual(run([{ from: '/flag', to: '/m', map: { true: 'exec', false: 'write' } }, { from: '/a', to: '/f', map: { y: 1, '*': 'other' } }], source), { m: 'exec', f: 'other' });
  assert.deepEqual(run([{ from: ['/r1', '/r2', '/none'], to: '/roles', join: 'union' }], source), { roles: ['admin', 'user', 'ops'] });
  assert.deepEqual(run([{ from: ['/parts', '/a'], to: '/s', join: '-' }], source), { s: 'a-b-x' });
  assert.deepEqual(run([{ from: '/scope', to: '/scopes', split: ' ' }], source), { scopes: ['read', 'write'] });
  assert.deepEqual(run([{ from: '/r1', to: '/k', map: { admin: 'root' } }], source), { k: ['root'] }, 'map applies per list item; unlisted items are dropped');
  assert.deepEqual(run([{ from: '/flag', to: '/risk', map: { false: 'write' } }], source, { risk: 'exec' }), { risk: 'exec' }, 'an unlisted value is not written');
  assert.deepEqual(run([{ drop: '/attrs/secret' }], source, { attrs: { secret: 1, keep: 2 } }), { attrs: { keep: 2 } });
  assert.deepEqual(run([{ from: '/old', to: '/new' }, { drop: '/old' }], { old: 1 }, { old: 1 }), { new: 1 }, 'copy then drop: a rename');
  assert.deepEqual(applyRules([{ from: '/old', to: '/new', drop: '/old' }], { old: 1 }, { old: 1 }, { key: 'k', direction: 'out' }), { new: 1 }, 'rename');
  assert.deepEqual(run([{ to: '/kind', default: 'user' }], source), { kind: 'user' });
});

test('a default is final: written as is, never split or looked up in the map table', () => {
  const rule: MappingRule = { from: '/annotations/destructiveHint', to: '/risk', map: { true: 'exec', false: 'write' }, default: 'exec' };
  assert.deepEqual(run([rule], {}), { risk: 'exec' }, 'missing source: the default, although the table does not list it');
  assert.deepEqual(run([rule], { annotations: { destructiveHint: null } }), { risk: 'exec' }, 'null source: the default');
  assert.deepEqual(run([rule], { annotations: { destructiveHint: false } }), { risk: 'write' }, 'a present value still goes through the table');
  assert.deepEqual(run([{ from: '/scope', to: '/scopes', split: ' ', default: 'a b' }], {}), { scopes: 'a b' }, 'not split');
  assert.deepEqual(run([{ from: '/x', to: '/y', map: { a: 1 }, default: { keep: true } }], {}), { y: { keep: true } }, 'any value, copied');
  assert.deepEqual(rulesAgainstShape([{ from: '/h', to: '/risk', map: { true: 'exec' }, default: 'nuclear' }], 'in', 'ToolSpec'),
    ['in[0].default: "nuclear" is not a risk value'], 'a default with a source is validated as a target value');
});

test('rules never change the source or the given target', () => {
  const source = { a: { b: 1 } };
  const target = { t: { u: 1 } };
  const out = run([{ from: '/a', to: '/t/a' }, { drop: '/t/u' }], source, target) as Record<string, unknown>;
  assert.deepEqual(target, { t: { u: 1 } });
  (out.t as { a: { b: number } }).a.b = 9;
  assert.equal(source.a.b, 1, 'values are copied, not shared');
});

test('ADR example: OIDC claims to caller roles, scopes, name and an ext key', () => {
  const rules: MappingRule[] = [
    { from: ['/realm_access/roles', '/resource_access/agent-api/roles', '/groups'], to: '/roles', join: 'union' },
    { from: '/scope', to: '/scopes', split: ' ' },
    { from: '/preferred_username', to: '/name' },
    { from: '/tenant', to: '/ext/oidc.tenant' },
  ];
  assert.deepEqual(rulesAgainstShape(rules, 'in', 'Caller', { namespace: 'oidc' }), []);
  const claims = { sub: 'u1', realm_access: { roles: ['analyst'] }, resource_access: { 'agent-api': { roles: ['writer', 'analyst'] } }, scope: 'openid notes:read', preferred_username: 'ada', tenant: 'acme' };
  const caller = createMappings('identity', { in: rules }, { check: { in: 'Caller' } }).in(claims, { id: 'u1', kind: 'user', roles: [], scopes: [] });
  assert.deepEqual(caller, { id: 'u1', kind: 'user', roles: ['analyst', 'writer'], scopes: ['openid', 'notes:read'], name: 'ada', ext: { 'oidc.tenant': 'acme' } });
});

test('ADR example: tool annotations to risk and attrs, then attrs to an AuthZEN wire', () => {
  const toolIn: MappingRule[] = [
    { from: '/annotations/destructiveHint', to: '/risk', map: { true: 'exec', false: 'write' }, default: 'exec' },
    { from: '/_meta/owner', to: '/attrs/owner' },
  ];
  assert.deepEqual(rulesAgainstShape(toolIn, 'in', 'ToolSpec', { namespace: 'mcp' }), []);
  const spec = createMappings('tools.crm', { in: toolIn }).in({ annotations: { destructiveHint: false }, _meta: { owner: 'sales' } }, { name: 'update', description: 'd', params: {} });
  assert.deepEqual(spec, { name: 'update', description: 'd', params: {}, risk: 'write', attrs: { owner: 'sales' } });

  const authOut: MappingRule[] = [
    { from: '/target/attrs/owner', to: '/resource/properties/owner' },
    { from: '/caller/ext/oidc.tenant', to: '/subject/properties/tenant' },
  ];
  assert.deepEqual(rulesAgainstShape(authOut, 'out', 'AccessQuestion'), []);
  assert.deepEqual(extReads(authOut), ['oidc.tenant']);
  const question = { caller: { id: 'u1', kind: 'user', roles: [], scopes: [], ext: { 'oidc.tenant': 'acme' } }, action: 'call', target: { kind: 'tool', id: 'crm__update', layer: 'tool', risk: 'write', agent: 'a', attrs: { owner: 'sales' } } };
  const wire = createMappings('authorization', { out: authOut }).out(question, { subject: { type: 'user', id: 'u1', properties: {} }, resource: { type: 'tool', id: 'crm__update' } });
  assert.deepEqual(wire, { subject: { type: 'user', id: 'u1', properties: { tenant: 'acme' } }, resource: { type: 'tool', id: 'crm__update', properties: { owner: 'sales' } } });
});

test('ADR example: knowledge payload to passage fields, dropping an internal attribute', () => {
  const rules: MappingRule[] = [
    { from: '/payload/title', to: '/title' },
    { from: '/payload/source_url', to: '/url' },
    { from: '/payload/lang', to: '/attrs/lang', default: 'en' },
    { drop: '/attrs/internal_notes' },
  ];
  assert.deepEqual(rulesAgainstShape(rules, 'in', 'Passage'), []);
  const p = createMappings('knowledge.handbook', { in: rules }, { check: { in: 'Passage' } })
    .in({ payload: { title: 'Leave', source_url: 'https://h/leave' } }, { id: '1', text: 't', source: 'handbook', attrs: { internal_notes: 'x' } });
  assert.deepEqual(p, { id: '1', text: 't', source: 'handbook', attrs: { lang: 'en' }, title: 'Leave', url: 'https://h/leave' });
});

test('ADR example: native guard findings to labels through a value table', () => {
  const rules: MappingRule[] = [{ from: '/entities', to: '/labels', map: { EMAIL_ADDRESS: 'pii', PHONE_NUMBER: 'pii', '*': 'other' } }];
  assert.deepEqual(rulesAgainstShape(rules, 'in', 'GuardVerdict', { namespace: 'presidio' }), []);
  const v = createMappings('guardrails.pii', { in: rules }).in({ entities: ['EMAIL_ADDRESS', 'IBAN'] }, { action: 'block' });
  assert.deepEqual(v, { action: 'block', labels: ['pii', 'other'] });
});

test('validation against the shape: unknown fields, foreign ext namespace, vocabulary values, out pointers', () => {
  const vocab = new Vocabularies([{ risk: { add: { admin: { like: 'exec' } } } }]);
  const problems = rulesAgainstShape([
    { from: '/x', to: '/nope' },
    { from: '/x', to: '/ext/other.key' },
    { from: '/x', to: '/risk', map: { a: 'admin', b: 'root' } },
    { to: '/layer', default: 'kitchen' },
    { from: '/x', to: '/name/deeper' },
  ], 'in', 'ToolSpec', { namespace: 'mcp', vocab });
  assert.equal(problems.length, 5, problems.join('\n'));
  assert.match(problems[0]!, /no field "nope"/);
  assert.match(problems[1]!, /outside the adapter's namespace "mcp"/);
  assert.match(problems[2]!, /map\["b"\]: "root" is not a risk value/);
  assert.match(problems[3]!, /"kitchen" is not a layer value/);
  assert.match(problems[4]!, /goes below a string field/);
  assert.match(rulesAgainstShape([{ from: '/target/nope', to: '/x' }], 'out', 'AccessQuestion')[0]!, /no field "nope"/);
});

test('mapped shapes are checked in development: an invalid result is a MappingError', () => {
  const m = createMappings('identity', { in: [{ to: '/kind', default: 'robot' }] }, { check: { in: 'Caller' } });
  assert.throws(() => m.in({}, { id: 'u', kind: 'user', roles: [], scopes: [] }), (e: unknown) => e instanceof MappingError && /identity: in: mapped Caller is invalid/.test(e.message));
  assert.doesNotThrow(() => createMappings('identity', { in: [{ to: '/kind', default: 'robot' }] }).in({}, {}), 'no check in production');
});

test('config block syntax: pointers, fields, fn references, keys', () => {
  const problems = mappingsProblems({
    identity: { in: [{ from: 'scope', to: '/scopes' }, { to: '/x' }, { fn: 'nohash' }, { fn: './f.mjs#f', to: '/x' }, { from: '/a', to: '/b', bogus: 1 }] },
    'tools.crm': { in: { $merge: 'append', items: [{ from: '/a', to: '/b' }] }, sideways: [] },
    'Bad Key': null,
  });
  assert.deepEqual(problems, [
    'mappings.identity.in[0].from: "scope" is not a JSON Pointer',
    'mappings.identity.in[1]: a rule without "from" needs a "default" (a constant)',
    'mappings.identity.in[2].fn: must be "<module path>#<export>"',
    'mappings.identity.in[3]: an fn rule takes no other field',
    'mappings.identity.in[4].bogus: unknown rule field',
    'mappings.tools.crm.sideways: unknown direction (in, out)',
    'mappings.Bad Key: key must be <slot> or <slot>.<instance>',
  ]);
});

test('defaults: a config list replaces them, append adds, null clears; profiles merge per direction', () => {
  const defaults: MappingRule[] = [{ from: '/a', to: '/a' }];
  const mine: MappingRule[] = [{ from: '/b', to: '/b' }];
  assert.deepEqual(effectiveRules(defaults, undefined), defaults);
  assert.deepEqual(effectiveRules(defaults, mine), mine);
  assert.deepEqual(effectiveRules(defaults, { $merge: 'append', items: mine }), [...defaults, ...mine]);
  assert.deepEqual(effectiveRules(defaults, null), []);
  const merged = mergeMappings({ identity: { in: defaults, out: mine } }, { identity: { in: { $merge: 'append', items: mine } }, authorization: { out: mine } });
  assert.deepEqual(merged, { identity: { in: [...defaults, ...mine], out: mine }, authorization: { out: mine } });
  assert.deepEqual(mergeMappings(merged, { identity: null }), { authorization: { out: mine } });
});

test('fn rules: loaded relative to the config directory, synchronous and given the context', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mappings-'));
  writeFileSync(join(dir, 'fns.mjs'), 'export const tag = (source, target, ctx) => ({ ...target, tag: `${ctx.key}:${ctx.direction}:${source.v}` });\n');
  const rules: MappingRule[] = [{ fn: './fns.mjs#tag' }];
  const fns = await loadMappingFunctions([rules], dir);
  assert.deepEqual(createMappings('tools.x', { in: rules }, { fns }).in({ v: 7 }, { a: 1 }), { a: 1, tag: 'tools.x:in:7' });
  await assert.rejects(loadMappingFunctions([[{ fn: './fns.mjs#missing' }]], dir), /export "missing" is not a function/);
  await assert.rejects(loadMappingFunctions([[{ fn: './nope.mjs#f' }]], dir), /failed to load/);
  assert.throws(() => createMappings('tools.x', { in: rules }).in({}, {}), /not loaded/);
});
