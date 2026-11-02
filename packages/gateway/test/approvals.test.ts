import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, ConfigError, recordingTelemetry, resolveProfile, type AccessQuestion, type Approval, type Stack } from '@agent-layers/core';
import { adapter as approvalAdapter } from '@agent-layers/adapter-memory-approval';
import { adapter as rulesAdapter } from '@agent-layers/adapter-rules-authorization';
import { identityAdapter } from '@agent-layers/adapter-static-identity';
import { serveStack } from '../src/index.ts';

const tokens = { 'op-key': { subject: 'olga', roles: ['operator'] }, 'user-key': { subject: 'ugo', roles: ['support'] } };
const rules = [{ effect: 'allow', actions: ['decide', 'list'], when: { roles: ['operator'] } }, { effect: 'allow', when: { authenticated: true } }];

const stackOf = (layers: Record<string, unknown> = {}, events: string[] = []) => compose(resolveProfile({
  agents: { a: { model: 'm' } },
  layers: {
    identity: { adapter: 'static-identity', options: { tokens } },
    approval: { adapter: 'memory-approval' },
    authorization: { adapter: 'rules-authorization', options: { rules, default: 'allow' } },
    ...layers,
  },
}), { adapters: [identityAdapter, approvalAdapter, rulesAdapter], telemetry: [recordingTelemetry((r) => { if (r.type === 'event') events.push(r.name); })] });

const question: AccessQuestion = {
  caller: { id: 'ugo', kind: 'user', roles: ['support'], scopes: [] }, action: 'call',
  target: { kind: 'tool', id: 'crm__delete', layer: 'tool', risk: 'write', agent: 'a' }, args: { customer: 'C-77' },
};
const ask = (stack: Stack, key = 'secret-request-key') => stack.ports.approval!.request({ question, agent: 'a', runId: 'r', key });

async function serve(stack: Stack, approvals: { enabled?: boolean; path?: string } = { enabled: true }) {
  const gw = await serveStack(stack, { port: 0, approvals });
  const call = (path: string, token?: string, init: RequestInit = {}) => fetch(`${gw.url}${path}`, {
    ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
  return { gw, call };
}

test('the approval routes are off unless enabled', async () => {
  const stack = await stackOf();
  const { gw, call } = await serve(stack, {});
  try {
    assert.equal((await call('/approvals', 'op-key')).status, 404);
    assert.ok(!gw.routes.some((r) => r.includes('approvals')));
  } finally {
    await gw.close();
    await stack.close();
  }
});

test('list and read: authenticated, authorized with action list, without the request key', async () => {
  const stack = await stackOf();
  const a = await ask(stack);
  const { gw, call } = await serve(stack);
  try {
    assert.equal((await call('/approvals')).status, 401);
    assert.equal((await call('/approvals', 'user-key')).status, 403, 'a rule without actions does not open list, whatever the default');
    const listed = await call('/approvals', 'op-key');
    assert.equal(listed.status, 200);
    const { approvals } = await listed.json() as { approvals: Approval[] };
    assert.deepEqual(approvals.map((x) => [x.id, x.status]), [[a.id, 'pending']]);
    assert.ok(!JSON.stringify(approvals).includes('secret-request-key'), 'the request key is not shown');
    assert.equal(((await (await call(`/approvals/${a.id}`, 'op-key')).json()) as Approval).id, a.id);
    assert.equal((await call(`/approvals/${a.id}`, 'user-key')).status, 403);
    assert.equal((await call('/approvals/missing', 'op-key')).status, 404);
    assert.equal((await call('/approvals/missing', 'user-key')).status, 403, 'an unauthorized caller cannot tell unknown ids from known ones');
    assert.equal((await call('/approvals?status=nope', 'op-key')).status, 400);
    assert.equal((await call('/approvals?limit=0', 'op-key')).status, 400);
    assert.deepEqual(((await (await call('/approvals?status=approved', 'op-key')).json()) as { approvals: unknown[] }).approvals, []);
  } finally {
    await gw.close();
    await stack.close();
  }
});

test('decide: action decide, recorded with the verified caller; a decided approval is a conflict', async () => {
  const events: string[] = [];
  const stack = await stackOf({}, events);
  const a = await ask(stack);
  const { gw, call } = await serve(stack);
  const post = (token: string, body: unknown) => call(`/approvals/${a.id}`, token, { method: 'POST', body: JSON.stringify(body) });
  try {
    assert.equal((await post('op-key', { decision: 'maybe' })).status, 400);
    assert.equal((await call(`/approvals/${a.id}`, 'op-key', { method: 'POST', body: '{' })).status, 400);
    const plain = await fetch(`${gw.url}/approvals/${a.id}`, { method: 'POST', headers: { authorization: 'Bearer op-key', 'content-type': 'text/plain' }, body: '{"decision":"approve"}' });
    assert.equal(plain.status, 415);
    assert.equal((await post('user-key', { decision: 'approve' })).status, 403);
    const decided = await post('op-key', { decision: 'approve', reason: 'checked' });
    assert.equal(decided.status, 200);
    const body = await decided.json() as Approval;
    assert.deepEqual([body.status, body.decidedBy, body.reason], ['approved', 'user:olga', 'checked']);
    assert.equal((await stack.ports.approval!.get(a.id))?.decidedBy, 'user:olga');
    const again = await post('op-key', { decision: 'deny' });
    assert.equal(again.status, 409);
    assert.ok(events.includes('gateway.approval.decided'));
  } finally {
    await gw.close();
    await stack.close();
  }
});

test('cancel: DELETE withdraws a pending approval; custom path', async () => {
  const stack = await stackOf();
  const a = await ask(stack);
  const { gw, call } = await serve(stack, { enabled: true, path: '/ops/approvals' });
  try {
    assert.equal((await call(`/approvals/${a.id}`, 'op-key', { method: 'DELETE' })).status, 404);
    assert.equal((await call(`/ops/approvals/${a.id}`, 'user-key', { method: 'DELETE' })).status, 403);
    const cancelled = await call(`/ops/approvals/${a.id}`, 'op-key', { method: 'DELETE' });
    assert.deepEqual(((await cancelled.json()) as Approval).status, 'cancelled');
    assert.equal((await stack.ports.approval!.get(a.id))?.decidedBy, 'user:olga');
    assert.equal((await call(`/ops/approvals/${a.id}`, 'op-key', { method: 'DELETE' })).status, 409);
  } finally {
    await gw.close();
    await stack.close();
  }
});

test('enabled without an approval or an authorization adapter is a configuration error', async () => {
  const noAuthz = await stackOf({ authorization: null });
  await assert.rejects(serveStack(noAuthz, { port: 0, approvals: { enabled: true } }), (err: unknown) => err instanceof ConfigError && /authorization adapter/.test(err.message));
  await noAuthz.close();
  const noApproval = await stackOf({ approval: null });
  await assert.rejects(serveStack(noApproval, { port: 0, approvals: { enabled: true } }), (err: unknown) => err instanceof ConfigError && /approval adapter/.test(err.message));
  await noApproval.close();
});
