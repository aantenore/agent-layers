import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessQuestion, evaluatePolicy, governedTools, policySubject, type AccessQuestion, type AuthorizationPort, type PolicyRule } from '../src/index.ts';
import { ctx, fakeTools } from './helpers.ts';

const spec = { name: 'db__write', description: 'w', params: {}, risk: 'write' as const };
const agentRules: PolicyRule[] = [
  { effect: 'allow', when: { kind: 'agent' } },
  { effect: 'allow', when: { roles: ['admin'] } },
  { effect: 'allow', when: { scopes: ['db:write'] } },
];

test('a call without a caller is an explicit anonymous caller, never the agent', () => {
  const q = accessQuestion('db__write', spec, {}, ctx());
  assert.deepEqual(q.caller, { kind: 'anonymous', id: 'anonymous', roles: [], scopes: [] });
  const agent = accessQuestion('db__write', spec, {}, ctx({ caller: { id: 'svc', kind: 'agent', roles: [], scopes: [], credential: 't' } }));
  assert.deepEqual(agent.caller, { id: 'svc', kind: 'agent', roles: [], scopes: [] }, 'the credential is stripped');
});

test('policySubject yields a caller only for user or agent callers with an id', () => {
  const base = accessQuestion('db__write', spec, {}, ctx());
  const withCaller = (caller: unknown): AccessQuestion => ({ ...base, caller: caller as AccessQuestion['caller'] });
  assert.equal(policySubject(base).caller, undefined);
  for (const kind of ['anonymous', 'Agent', 'service', 'agent ', '']) {
    assert.equal(policySubject(withCaller({ kind, id: 'x', roles: ['admin'], scopes: ['db:write'] })).caller, undefined, kind);
  }
  assert.equal(policySubject(withCaller({ kind: 'agent', id: '', roles: [], scopes: [] })).caller, undefined);
  assert.deepEqual(policySubject(withCaller({ kind: 'agent', id: 'svc', roles: ['r', 1], scopes: [] })).caller,
    { id: 'svc', kind: 'agent', roles: ['r'], scopes: [] });
  assert.equal(policySubject({ ...base, target: { ...base.target, risk: 'bogus' } }).risk, 'exec');
});

test('anonymous calls never match agent, role or scope rules: locally and through a PDP', async () => {
  const anon = accessQuestion('db__write', spec, {}, ctx());
  assert.equal(evaluatePolicy(agentRules, policySubject(anon)), undefined);
  assert.equal(evaluatePolicy(agentRules, { tool: 'db__write', risk: 'write' }), undefined);

  const pdp: AuthorizationPort = { evaluate: async (q) => ({ allowed: evaluatePolicy(agentRules, policySubject(q)) === 'allow' }) };
  const tools = (o: Parameters<typeof governedTools>[1]) => governedTools({ db: fakeTools([{ name: 'write', risk: 'write' }]) }, o);
  const agent = { id: 'svc', kind: 'agent' as const, roles: [], scopes: [], credential: 't' };
  for (const opts of [{ policy: [...agentRules, { effect: 'deny' as const }] }, { authorization: pdp }]) {
    assert.equal((await tools(opts).callTool('db__write', {}, ctx())).ok, false, 'anonymous denied');
    assert.equal((await tools(opts).callTool('db__write', {}, ctx({ caller: agent }))).ok, true, 'agent allowed');
  }
});

test('when.authenticated matches verified callers or anonymous ones only', () => {
  const rules: PolicyRule[] = [{ effect: 'deny', when: { authenticated: false } }, { effect: 'allow', when: { authenticated: true } }];
  assert.equal(evaluatePolicy(rules, { tool: 't', risk: 'read' }), 'deny');
  assert.equal(evaluatePolicy(rules, { tool: 't', risk: 'read', caller: { id: 'u', kind: 'user', roles: [], scopes: [] } }), 'allow');
  assert.equal(evaluatePolicy(rules, { tool: 't', risk: 'read', caller: { id: 'svc', kind: 'agent', roles: [], scopes: [] } }), 'allow');
  assert.equal(evaluatePolicy([{ effect: 'allow', when: { authenticated: true, roles: ['admin'] } }], { tool: 't', risk: 'read', caller: { id: 'u', kind: 'user', roles: [], scopes: [] } }), undefined);
});
