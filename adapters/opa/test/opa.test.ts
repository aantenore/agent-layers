import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMappings, governedTools, MappingError, type ToolPort } from '@agent-layers/core';
import { checkAdapter, sampleQuestion } from '@agent-layers/conformance';
import { adapter, createOpa, LIMITS } from '../src/index.ts';
import { pdp, question, referencePolicy, send } from './helpers.ts';

/** OPA Data API: `agents/allow` is a boolean, `agents/decision` an object, anything else undefined. */
const opa = () => pdp((body, _h, res) => {
  const d = referencePolicy(body.input);
  send(res, 200, res.req.url === '/v1/data/agents/allow' ? { result: d.allow } : res.req.url === '/v1/data/agents/decision' ? { result: d } : {});
});

const user = (id: string, roles: string[]) => ({ id, kind: 'user', roles, scopes: [] });
const anon = { kind: 'anonymous', id: 'anonymous', roles: [], scopes: [] };

test('posts { input: AccessQuestion } in language names to the Data API, without arguments unless asked', async () => {
  const s = await opa();
  try {
    assert.deepEqual(await createOpa({ url: s.url }).evaluate(question(user('alice', ['analyst']), 'write')), { allowed: true, reason: 'allowed' });
    assert.equal(s.seen[0]!.path, '/v1/data/agents/decision');
    const { args: _args, ...withoutArgs } = question(user('alice', ['analyst']), 'write');
    assert.deepEqual(s.seen[0]!.body, { input: withoutArgs });
    assert.deepEqual(await createOpa({ url: `${s.url}/`, path: '/agents/allow/', includeArgs: true }).evaluate(question(user('bob', ['viewer']), 'write')), { allowed: false });
    assert.equal(s.seen[1]!.path, '/v1/data/agents/allow');
    assert.deepEqual(s.seen[1]!.body.input.args, { path: '/etc/secret' });
    const bob = await createOpa({ url: s.url, headers: { authorization: 'Bearer opa-key' } }).evaluate(question(user('bob', ['viewer']), 'write'));
    assert.deepEqual(bob, { allowed: false, reason: 'user bob may not call write tools' });
    assert.equal(s.seen[2]!.headers.authorization, 'Bearer opa-key');
  } finally {
    await s.close();
  }
});

test('anonymous and malformed callers reach OPA as anonymous; a credential never leaves the stack', async () => {
  const s = await opa();
  try {
    const authz = createOpa({ url: s.url });
    for (const caller of [anon, { kind: 'AGENT', id: 'notes', roles: [], scopes: [] }, { kind: 'agent', id: '' }, { kind: 'admin', id: 'root', roles: ['analyst'] }, undefined]) {
      assert.equal((await authz.evaluate(question(caller))).allowed, false, JSON.stringify(caller));
      assert.deepEqual(s.seen.at(-1)!.body.input.caller, anon);
    }
    assert.equal((await authz.evaluate(question({ kind: 'agent', id: 'svc', roles: ['x', 1], scopes: 'all', credential: 'raw-token' }))).allowed, true);
    assert.deepEqual(s.seen.at(-1)!.body.input.caller, { kind: 'agent', id: 'svc', roles: ['x'], scopes: [] });
    assert.ok(!s.seen.some((r) => JSON.stringify(r.body).includes('raw-token')));

    const tools: ToolPort = { listTools: async () => [{ name: 'list', description: 'l', params: {}, risk: 'read' }], callTool: async () => ({ ok: true, text: 'listed' }) };
    const governed = governedTools({ notes: tools }, { authorization: authz });
    const run = (caller?: { id: string; kind: 'agent'; roles: string[]; scopes: string[] }) => governed.callTool('notes__list', {}, { runId: 'r', agent: 'notes', ...(caller ? { caller } : {}) });
    const denied = await run();
    assert.deepEqual([denied.ok, denied.text], [false, 'Denied: anonymous anonymous may not call read tools']);
    const allowed = await run({ id: 'svc', kind: 'agent', roles: [], scopes: [] });
    assert.deepEqual([allowed.ok, allowed.text], [true, 'listed']);
  } finally {
    await s.close();
  }
});

test('out mappings shape the input; a failing mapping denies without a request', async () => {
  const s = await opa();
  try {
    const mappings = createMappings('authorization', { out: [{ from: '/caller/roles', to: '/caller/groups' }, { from: '/args', to: '/leaked' }] });
    await createOpa({ url: s.url }, { mappings }).evaluate(question(user('alice', ['analyst'])));
    assert.deepEqual(s.seen[0]!.body.input.caller.groups, ['analyst']);
    assert.equal(s.seen[0]!.body.input.leaked, undefined, 'arguments stay inside the stack without includeArgs');
    const broken = createMappings('authorization', { out: [{ from: '/caller/id', to: '/__proto__/x' }] });
    await assert.rejects(createOpa({ url: s.url }, { mappings: broken }).evaluate(question(user('alice', ['analyst']))), MappingError);
    assert.equal(s.seen.length, 1);
  } finally {
    await s.close();
  }
});

test('fails closed: undefined rules, non-boolean results, errors and slow answers reject', async () => {
  const s = await opa();
  try {
    await assert.rejects(createOpa({ url: s.url, path: 'agents/missing' }).evaluate(sampleQuestion()), /data\.agents\.missing is undefined/);
    const authz = createOpa({ url: s.url, timeoutMs: 300 });
    const replies: [number, unknown, RegExp][] = [
      [200, { result: 'true' }, /not a boolean decision/],
      [200, { result: { allow: 1 } }, /not a boolean decision/],
      [200, { result: [true] }, /not a boolean decision/],
      [200, { result: null }, /not a boolean decision/],
      [400, { code: 'invalid_parameter' }, /HTTP 400/],
      [500, { result: true }, /HTTP 500/],
      [200, { result: true, pad: 'x'.repeat(LIMITS.maxResponseBytes.default as number) }, /too large/],
    ];
    for (const [status, body, pattern] of replies) {
      s.state.reply = (_b, _h, res) => send(res, status, body);
      await assert.rejects(authz.evaluate(sampleQuestion()), pattern);
    }
    s.state.reply = (_b, _h, res) => { res.writeHead(307, { location: '/v1/data/agents/allow' }).end(); };
    await assert.rejects(authz.evaluate(sampleQuestion()), /redirect|request failed/);
    assert.equal(s.seen.filter((r) => r.path === '/v1/data/agents/allow').length, 0);
    s.state.reply = () => new Promise(() => {});
    await assert.rejects(authz.evaluate(sampleQuestion()), /timed out/);
  } finally {
    await s.close();
  }
});

test('https is required outside loopback; policy paths are validated', () => {
  assert.throws(() => createOpa({ url: 'http://opa.example.com' }), /https/);
  for (const path of ['../admin', 'agents/../x', 'agents/allow?x=1', 'a//b', '']) assert.throws(() => createOpa({ url: 'https://opa.example.com', path }), /path/, path);
  createOpa({ url: 'https://opa.example.com', path: 'agents/v2/allow' });
});

test('opa passes AuthorizationPort conformance', async () => {
  const s = await opa();
  try {
    const report = await checkAdapter(adapter, {
      options: { url: s.url },
      fixtures: {
        allow: [sampleQuestion({ roles: ['viewer'] }), sampleQuestion({ roles: ['analyst'], risk: 'write' }), sampleQuestion({ kind: 'agent' })],
        deny: [sampleQuestion(), sampleQuestion({ roles: ['viewer'], risk: 'write' }), sampleQuestion({ kind: 'agent', risk: 'exec' })],
      },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await s.close();
  }
});
