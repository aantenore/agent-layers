import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleQuestion } from '@agent-layers/conformance';
import { ANONYMOUS, Vocabularies, type PolicyRule } from '@agent-layers/core';
import { createRulesAuthorization } from '../src/index.ts';

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
