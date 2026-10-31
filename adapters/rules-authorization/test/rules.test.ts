import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleAccess } from '@agent-layers/conformance';
import type { PolicyRule } from '@agent-layers/core';
import { createRulesAuthorization } from '../src/index.ts';

const rules: PolicyRule[] = [
  { effect: 'deny', tools: ['shell__*'] },
  { effect: 'ask', risk: ['write'] },
  { effect: 'allow', tools: ['docs__*'], when: { roles: ['staff'] } },
];

test('first matching rule decides', async () => {
  const port = createRulesAuthorization({ rules, default: 'allow' });
  const denied = await port.evaluate(sampleAccess({ tool: 'shell__run', risk: 'write' }));
  assert.equal(denied.decision, false);
  assert.equal(denied.context?.reason, 'denied by rule');
});

test('ask is refused with an approval reason', async () => {
  const port = createRulesAuthorization({ rules });
  const res = await port.evaluate(sampleAccess({ tool: 'files__save', risk: 'write' }));
  assert.deepEqual(res, { decision: false, context: { reason: 'approval required' } });
});

test('rule conditions use the caller roles', async () => {
  const port = createRulesAuthorization({ rules });
  assert.equal((await port.evaluate(sampleAccess({ tool: 'docs__read', roles: ['staff'] }))).decision, true);
  assert.equal((await port.evaluate(sampleAccess({ tool: 'docs__read', roles: [] }))).decision, false);
});

test('no match falls back to the default, deny unless set', async () => {
  const req = sampleAccess({ tool: 'other__x' });
  const closed = await createRulesAuthorization({ rules: [] }).evaluate(req);
  assert.deepEqual(closed, { decision: false, context: { reason: 'no rule matched (default deny)' } });
  const open = await createRulesAuthorization({ rules: [], default: 'allow' }).evaluate(req);
  assert.deepEqual(open, { decision: true, context: { reason: 'no rule matched (default allow)' } });
});

test('when.authenticated scopes a rule to verified subjects', async () => {
  const port = createRulesAuthorization({ rules: [{ effect: 'allow', risk: ['read'], when: { authenticated: true } }] });
  const user = sampleAccess({ tool: 'docs__read', risk: 'read' });
  assert.equal((await port.evaluate(user)).decision, true);
  const anon = sampleAccess({ tool: 'docs__read', risk: 'read' });
  anon.subject = { type: 'anonymous', id: 'anonymous', properties: { roles: [], scopes: [], authenticated: false } };
  assert.equal((await port.evaluate(anon)).decision, false);
});
