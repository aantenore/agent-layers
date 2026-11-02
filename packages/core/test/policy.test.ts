import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessQuestion, evaluatePolicy, governedTools, policySubject, Vocabularies, type AccessQuestion, type AuthorizationPort, type PolicyRule } from '../src/index.ts';
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

test('actor rules: the current actor by default, prior actors only when a rule asks for them', () => {
  const chain = { id: 'u-1', kind: 'user' as const, roles: [], scopes: [], actors: [{ id: 'planner', kind: 'agent' as const }, { id: 'billing-bot', kind: 'agent' as const }] };
  const plain = { id: 'u-2', kind: 'user' as const, roles: [], scopes: [] };
  const subject = (caller: typeof chain | typeof plain) => ({ tool: 'erp__pay', risk: 'write' as const, caller });
  assert.equal(evaluatePolicy([{ effect: 'allow', when: { actor: ['billing-*'] } }], subject(chain)), 'allow');
  assert.equal(evaluatePolicy([{ effect: 'allow', when: { actor: ['planner'] } }], subject(chain)), undefined, 'a prior actor is not the current one');
  assert.equal(evaluatePolicy([{ effect: 'deny', when: { actors: ['planner'] } }], subject(chain)), 'deny');
  assert.equal(evaluatePolicy([{ effect: 'allow', when: { actor: ['*'] } }], subject(plain)), undefined);
  assert.equal(evaluatePolicy([{ effect: 'deny', when: { delegated: true } }], subject(plain)), undefined);
  assert.equal(evaluatePolicy([{ effect: 'deny', when: { delegated: false } }], subject(plain)), 'deny');
  const q = { caller: { ...chain, actors: [...chain.actors, { id: 7 }] }, action: 'call', target: { kind: 'tool', id: 'erp__pay', layer: 'tool' as const, risk: 'write', agent: 'a' } };
  const malformed = policySubject(q as never).caller;
  assert.deepEqual(malformed?.actors, [...chain.actors, { id: '', kind: 'agent' }], 'a malformed actor stays as one that matches nothing but *');
  assert.equal(evaluatePolicy([{ effect: 'allow', when: { delegated: false } }], { tool: 'erp__pay', risk: 'write', caller: malformed! }), undefined, 'a malformed chain counts as delegated');
  assert.equal(evaluatePolicy([{ effect: 'allow', when: { actor: ['billing-*'] } }], { tool: 'erp__pay', risk: 'write', caller: malformed! }), undefined);
  const notList = policySubject({ ...q, caller: { ...chain, actors: { id: 'x' } } } as never).caller;
  assert.equal(notList?.actors?.length, 1, 'a chain that is not a list is delegated too');
});

test('actor rules with issuer: an actor id matches only at the issuer that vouches for it', () => {
  const caller = { id: 'u', kind: 'user' as const, roles: [], scopes: [], actors: [{ id: 'bot', kind: 'agent' as const, issuer: 'https://idp-b.example' }] };
  const subject = { tool: 't', risk: 'read' as const, caller };
  assert.equal(evaluatePolicy([{ effect: 'allow', when: { actor: ['bot'], issuer: ['https://idp-a.*'] } }], subject), undefined);
  assert.equal(evaluatePolicy([{ effect: 'allow', when: { actors: ['bot'], issuer: ['https://idp-b.*'] } }], subject), 'allow');
  const unvouched = { ...caller, actors: [{ id: 'bot', kind: 'agent' as const }] };
  assert.equal(evaluatePolicy([{ effect: 'allow', when: { actor: ['bot'], issuer: ['*'] } }], { ...subject, caller: unvouched }), undefined);
  // Globs span line breaks: an id with a newline cannot slip past a "*" rule.
  assert.equal(evaluatePolicy([{ effect: 'deny', when: { actor: ['*'] } }], { ...subject, caller: { ...caller, actors: [{ id: 'evil\nbot', kind: 'agent' }] } }), 'deny');
});

test('actions: a rule without actions matches tool calls only; a rule on a core action matches the values added like it', () => {
  const vocab = new Vocabularies([{ action: { add: { approve: { like: 'decide' }, invoke: { like: 'call' } } } }]);
  const rules: PolicyRule[] = [{ effect: 'allow', actions: ['decide'], when: { roles: ['operator'] } }, { effect: 'deny' }];
  const operator = { id: 'o', kind: 'user' as const, roles: ['operator'], scopes: [] };
  assert.equal(evaluatePolicy(rules, { tool: 'apr-1', risk: 'write', caller: operator, action: 'decide' }, vocab), 'allow');
  assert.equal(evaluatePolicy(rules, { tool: 'apr-1', risk: 'write', caller: operator, action: 'approve' }, vocab), 'allow');
  assert.equal(evaluatePolicy(rules, { tool: 'apr-1', risk: 'read', caller: operator, action: 'list' }, vocab), undefined, 'the catch-all deny has no actions: it does not match list');
  assert.equal(evaluatePolicy(rules, { tool: 'db__write', risk: 'write', caller: operator }, vocab), 'deny', 'no action is a tool call');
  assert.equal(evaluatePolicy(rules, { tool: 'db__write', risk: 'write', caller: operator, action: 'invoke' }, vocab), 'deny', 'an action added like call is a tool call');
  const q: AccessQuestion = { caller: operator, action: 'list', target: { kind: 'approval', id: '*', layer: 'identity', risk: 'read', agent: '*' } };
  assert.equal(policySubject(q).action, 'list');
});
