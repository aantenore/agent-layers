import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleQuestion } from '@agent-layers/conformance';
import { AdapterRegistry, ANONYMOUS, noopTelemetry, Vocabularies, type AccessQuestion, type PolicyRule } from '@agent-layers/core';
import { adapter, createRulesAuthorization } from '../../src/rules-authorization/index.ts';

const rules: PolicyRule[] = [
  { effect: 'deny', tools: ['shell__*'] },
  { effect: 'ask', risk: ['write'] },
  { effect: 'allow', tools: ['docs__*'], when: { roles: ['staff'] } },
];

test('first matching rule decides', async () => {
  const port = createRulesAuthorization({ rules, default: 'allow' });
  const denied = await port.evaluate(sampleQuestion({ tool: 'shell__run', risk: 'write' }));
  assert.deepEqual(denied, { allowed: false, reason: 'denied by rule' });
});

test('ask is refused with an approval reason', async () => {
  const port = createRulesAuthorization({ rules });
  const res = await port.evaluate(sampleQuestion({ tool: 'files__save', risk: 'write' }));
  assert.deepEqual(res, { allowed: false, reason: 'approval required' });
});

test('rule conditions use the caller roles', async () => {
  const port = createRulesAuthorization({ rules });
  assert.equal((await port.evaluate(sampleQuestion({ tool: 'docs__read', roles: ['staff'] }))).allowed, true);
  assert.equal((await port.evaluate(sampleQuestion({ tool: 'docs__read', roles: [] }))).allowed, false);
});

test('no match falls back to the default, deny unless set', async () => {
  const q = sampleQuestion({ tool: 'other__x' });
  assert.deepEqual(await createRulesAuthorization({ rules: [] }).evaluate(q), { allowed: false, reason: 'no rule matched (default deny)' });
  assert.deepEqual(await createRulesAuthorization({ rules: [], default: 'allow' }).evaluate(q), { allowed: true, reason: 'no rule matched (default allow)' });
});

test('when.authenticated scopes a rule to verified callers; anonymous and unknown kinds are not callers', async () => {
  const port = createRulesAuthorization({ rules: [{ effect: 'allow', risk: ['read'], when: { authenticated: true } }] });
  assert.equal((await port.evaluate(sampleQuestion({ tool: 'docs__read', risk: 'read' }))).allowed, true);
  const anon = { ...sampleQuestion({ tool: 'docs__read', risk: 'read' }), caller: { ...ANONYMOUS, roles: [] as [], scopes: [] as [] } };
  assert.equal((await port.evaluate(anon)).allowed, false);
  const odd = { ...sampleQuestion({ tool: 'docs__read', risk: 'read' }), caller: { id: 'root', kind: 'service', roles: ['staff'], scopes: [] } } as never;
  assert.equal((await port.evaluate(odd)).allowed, false);
});

test('risks added in config match rules on their like value, read at call time; unknown risks count as exec', async () => {
  let vocab: Vocabularies | undefined;
  const port = createRulesAuthorization({ rules: [{ effect: 'allow', risk: ['read'] }, { effect: 'deny', risk: ['exec'] }], default: 'allow' }, 'rules', () => vocab);
  const q = { ...sampleQuestion(), target: { ...sampleQuestion().target, risk: 'lookup' } };
  assert.deepEqual(await port.evaluate(q), { allowed: false, reason: 'denied by rule' }, 'unknown risk: exec');
  vocab = new Vocabularies([{ risk: { add: { lookup: { like: 'read' } } } }]);
  assert.deepEqual(await port.evaluate(q), { allowed: true, reason: 'allowed by rule' });
  const broken = createRulesAuthorization({ rules: [{ effect: 'deny', risk: ['exec'] }], default: 'allow' }, 'rules', () => { throw new Error('not composed'); });
  assert.equal((await broken.evaluate(q)).allowed, false, 'vocabularies unavailable: core values only');
});

const withActors = (actors: unknown, tool = 'docs__read'): AccessQuestion =>
  ({ ...sampleQuestion({ tool }), caller: { ...sampleQuestion({ tool }).caller, ...(actors === undefined ? {} : { actors }) } }) as AccessQuestion;
const chain = [{ id: 'planner', kind: 'agent' }, { id: 'notes-agent', kind: 'agent' }];

test('when.actor matches the current actor only, the last of the chain', async () => {
  const port = createRulesAuthorization({ rules: [{ effect: 'allow', when: { actor: ['notes-*'] } }] });
  assert.equal((await port.evaluate(withActors(chain))).allowed, true);
  assert.equal((await port.evaluate(withActors([...chain].reverse()))).allowed, false, 'a prior actor does not count');
  assert.equal((await port.evaluate(withActors(undefined))).allowed, false, 'no actors, no match');
  assert.equal((await port.evaluate(withActors([]))).allowed, false);
});

test('when.actors matches any actor of the chain, prior ones included, only when asked', async () => {
  const deny = createRulesAuthorization({ rules: [{ effect: 'deny', when: { actors: ['planner'] } }], default: 'allow' });
  assert.equal((await deny.evaluate(withActors(chain))).allowed, false);
  assert.equal((await deny.evaluate(withActors([{ id: 'notes-agent', kind: 'agent' }]))).allowed, true);
  assert.equal((await deny.evaluate(withActors(undefined))).allowed, true);
  const current = createRulesAuthorization({ rules: [{ effect: 'deny', when: { actor: ['planner'] } }], default: 'allow' });
  assert.equal((await current.evaluate(withActors(chain))).allowed, true, 'actor ignores the prior planner');
});

test('when.delegated tells a delegated call from a direct one; a malformed chain is denied whatever the rules say', async () => {
  const port = createRulesAuthorization({ rules: [{ effect: 'allow', when: { delegated: true } }, { effect: 'deny', when: { delegated: false } }] });
  assert.equal((await port.evaluate(withActors(chain))).allowed, true);
  assert.equal((await port.evaluate(withActors(undefined))).allowed, false);
  const malformed = await port.evaluate(withActors([...(chain as unknown[]), { id: 'x', kind: 'robot' }]));
  assert.deepEqual(malformed, { allowed: false, reason: 'malformed delegation chain (denied)' }, 'fails closed even under an allow rule');
});

test('the options schema accepts actor, actors and delegated and refuses wrong types', async () => {
  const registry = new AdapterRegistry().register(adapter);
  const ctx = { name: 'rules-authorization', env: {}, cwd: process.cwd(), telemetry: noopTelemetry };
  const options = (when: unknown) => ({ rules: [{ effect: 'allow', when }] });
  await registry.create('AuthorizationPort', 'rules-authorization', options({ actor: ['a'], actors: ['b-*'], delegated: true }), ctx);
  for (const bad of [{ actor: 'a' }, { actors: [1] }, { delegated: 'yes' }, { delegate: true }]) {
    await assert.rejects(registry.create('AuthorizationPort', 'rules-authorization', options(bad), ctx), /rules|when|actor|delegat|additional|invalid/i, JSON.stringify(bad));
  }
});

test('approval actions match only rules that name them; the default never allows them', async () => {
  const question = (action: string, roles: string[]): AccessQuestion => ({
    ...sampleQuestion({ roles }), action, target: { kind: 'approval', id: 'apr-1', layer: 'identity', risk: 'write', agent: 'support' },
  });
  const port = createRulesAuthorization({
    rules: [{ effect: 'allow', actions: ['decide', 'list'], when: { roles: ['operator'] } }, { effect: 'allow', when: { authenticated: true } }],
    default: 'allow',
  });
  assert.equal((await port.evaluate(question('decide', ['operator']))).allowed, true);
  assert.equal((await port.evaluate(question('list', ['operator']))).allowed, true);
  const other = await port.evaluate(question('decide', ['support']));
  assert.deepEqual(other, { allowed: false, reason: 'no rule matched action "decide" (denied)' }, 'a rule without actions never opens decide');
  assert.equal((await port.evaluate(sampleQuestion({ roles: ['support'] }))).allowed, true, 'tool calls still match rules without actions');
  const vocab = new Vocabularies([{ action: { add: { approve: { like: 'decide' } } } }]);
  const liked = createRulesAuthorization({ rules: [{ effect: 'allow', actions: ['decide'] }] }, 'r', () => vocab);
  assert.equal((await liked.evaluate(question('approve', []))).allowed, true, 'a rule on a core action matches values added like it');
});
