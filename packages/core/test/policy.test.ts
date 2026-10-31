import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePolicy, governedTools, subjectOf, toolAccessRequest, type AccessRequest, type AuthorizationPort, type PolicyRule } from '../src/index.ts';
import { ctx, fakeTools } from './helpers.ts';

const spec = { name: 'db__write', description: 'w', inputSchema: {}, risk: 'write' as const };
const agentRules: PolicyRule[] = [
  { effect: 'allow', when: { kind: 'agent' } },
  { effect: 'allow', when: { roles: ['admin'] } },
  { effect: 'allow', when: { scopes: ['db:write'] } },
];

test('a call without identity is an explicit anonymous subject, never the agent', () => {
  const req = toolAccessRequest('db__write', spec, {}, ctx());
  assert.deepEqual(req.subject, { type: 'anonymous', id: 'anonymous', properties: { roles: [], scopes: [], authenticated: false } });
  const agent = toolAccessRequest('db__write', spec, {}, ctx({ identity: { subject: 'svc', kind: 'agent', token: 't' } }));
  assert.deepEqual(agent.subject, { type: 'agent', id: 'svc', properties: { roles: [], scopes: [], authenticated: true } });
});

test('subjectOf yields an identity only for authenticated user or agent subjects', () => {
  const base = toolAccessRequest('db__write', spec, {}, ctx());
  const withSubject = (subject: AccessRequest['subject']): AccessRequest => ({ ...base, subject });
  assert.equal(subjectOf(base).identity, undefined);
  for (const type of ['anonymous', 'Agent', 'service', 'agent ', '']) {
    assert.equal(subjectOf(withSubject({ type, id: 'x', properties: { roles: ['admin'], scopes: ['db:write'] } })).identity, undefined, type);
  }
  assert.equal(subjectOf(withSubject({ type: 'agent', id: 'x', properties: { authenticated: false } })).identity, undefined);
  assert.equal(subjectOf(withSubject({ type: 'agent', id: '' })).identity, undefined);
  assert.deepEqual(subjectOf(withSubject({ type: 'agent', id: 'svc', properties: { roles: ['r', 1] as string[], authenticated: true } })).identity,
    { subject: 'svc', kind: 'agent', roles: ['r'], scopes: [] });
  assert.equal(subjectOf({ ...base, resource: { type: 'tool', id: 't', properties: { risk: 'bogus' as 'read' } } }).risk, 'exec');
});

test('anonymous calls never match agent, role or scope rules: locally and through a PDP', async () => {
  const anon = toolAccessRequest('db__write', spec, {}, ctx());
  assert.equal(evaluatePolicy(agentRules, subjectOf(anon)), undefined);
  assert.equal(evaluatePolicy(agentRules, { tool: 'db__write', risk: 'write' }), undefined);

  const pdp: AuthorizationPort = { evaluate: async (r) => ({ decision: evaluatePolicy(agentRules, subjectOf(r)) === 'allow' }) };
  const tools = (o: Parameters<typeof governedTools>[1]) => governedTools({ db: fakeTools([{ name: 'write', risk: 'write' }]) }, o);
  const agent = { subject: 'svc', kind: 'agent' as const, token: 't' };
  for (const opts of [{ policy: [...agentRules, { effect: 'deny' as const }] }, { authorization: pdp }]) {
    assert.equal((await tools(opts).callTool('db__write', {}, ctx())).isError, true, 'anonymous denied');
    assert.equal((await tools(opts).callTool('db__write', {}, ctx({ identity: agent }))).isError, undefined, 'agent allowed');
  }
});

test('when.authenticated matches verified callers or anonymous ones only', () => {
  const rules: PolicyRule[] = [{ effect: 'deny', when: { authenticated: false } }, { effect: 'allow', when: { authenticated: true } }];
  assert.equal(evaluatePolicy(rules, { tool: 't', risk: 'read' }), 'deny');
  assert.equal(evaluatePolicy(rules, { tool: 't', risk: 'read', identity: { subject: 'u', kind: 'user' } }), 'allow');
  assert.equal(evaluatePolicy(rules, { tool: 't', risk: 'read', identity: { subject: 'svc', kind: 'agent' } }), 'allow');
  assert.equal(evaluatePolicy([{ effect: 'allow', when: { authenticated: true, roles: ['admin'] } }], { tool: 't', risk: 'read', identity: { subject: 'u', kind: 'user' } }), undefined);
});
