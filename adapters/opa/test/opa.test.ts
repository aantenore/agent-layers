import assert from 'node:assert/strict';
import { test } from 'node:test';
import { governedTools, type ToolPort } from '@agent-layers/core';
import { checkAdapter, sampleAccess } from '@agent-layers/conformance';
import { adapter, createOpa, MAX_RESPONSE_BYTES } from '../src/index.ts';
import { pdp, referencePolicy, request, send } from './helpers.ts';

/** OPA Data API: `agents/allow` is a boolean, `agents/decision` an object, anything else undefined. */
const opa = () => pdp((body, _h, res) => {
  const d = referencePolicy(body.input);
  send(res, 200, res.req.url === '/v1/data/agents/allow' ? { result: d.allow } : res.req.url === '/v1/data/agents/decision' ? { result: d } : {});
});

const user = (id: string, roles: string[]) => ({ type: 'user', id, properties: { roles, scopes: [], authenticated: true } });

test('posts { input } to the Data API, without arguments unless asked', async () => {
  const s = await opa();
  try {
    assert.deepEqual(await createOpa({ url: s.url }).evaluate(request(user('alice', ['analyst']), 'write')), { decision: true, context: { reason: 'allowed' } });
    assert.equal(s.seen[0]!.path, '/v1/data/agents/decision');
    assert.deepEqual(s.seen[0]!.body, { input: { ...request(user('alice', ['analyst']), 'write'), context: { channel: 'http' } } });
    assert.deepEqual(await createOpa({ url: `${s.url}/`, path: '/agents/allow/', includeArgs: true }).evaluate(request(user('bob', ['viewer']), 'write')), { decision: false });
    assert.equal(s.seen[1]!.path, '/v1/data/agents/allow');
    assert.deepEqual(s.seen[1]!.body.input.context, { channel: 'http', args: { path: '/etc/secret' } });
    const bob = await createOpa({ url: s.url, headers: { authorization: 'Bearer opa-key' } }).evaluate(request(user('bob', ['viewer']), 'write'));
    assert.deepEqual(bob, { decision: false, context: { reason: 'user bob may not call write tools' } });
    assert.equal(s.seen[2]!.headers.authorization, 'Bearer opa-key');
  } finally {
    await s.close();
  }
});

test('anonymous and malformed subjects reach OPA as anonymous and never match agent rules', async () => {
  const s = await opa();
  try {
    const authz = createOpa({ url: s.url });
    const anon = { type: 'anonymous', id: 'anonymous', properties: { roles: [], scopes: [], authenticated: false } };
    for (const subject of [anon, { type: 'agent', id: 'notes', properties: { authenticated: false } }, { type: 'AGENT', id: 'notes' }, { type: 'admin', id: 'root', properties: { roles: ['analyst'] } }]) {
      assert.equal((await authz.evaluate(request(subject))).decision, false, JSON.stringify(subject));
      assert.deepEqual(s.seen.at(-1)!.body.input.subject, anon);
    }
    const tools: ToolPort = { listTools: async () => [{ name: 'list', description: 'l', inputSchema: {}, risk: 'read' }], callTool: async () => ({ content: 'listed' }) };
    const governed = governedTools({ notes: tools }, { authorization: authz });
    const run = (identity?: { subject: string; kind: 'agent' }) => governed.callTool('notes__list', {}, { runId: 'r', agent: 'notes', ...(identity ? { identity } : {}) });
    assert.deepEqual(await run(), { content: 'Denied: anonymous anonymous may not call read tools', isError: true });
    assert.deepEqual(await run({ subject: 'svc', kind: 'agent' }), { content: 'listed' });
  } finally {
    await s.close();
  }
});

test('fails closed: undefined rules, non-boolean results, errors and slow answers reject', async () => {
  const s = await opa();
  try {
    await assert.rejects(createOpa({ url: s.url, path: 'agents/missing' }).evaluate(sampleAccess()), /data\.agents\.missing is undefined/);
    const authz = createOpa({ url: s.url, timeoutMs: 300 });
    const replies: [number, unknown, RegExp][] = [
      [200, { result: 'true' }, /not a boolean decision/],
      [200, { result: { allow: 1 } }, /not a boolean decision/],
      [200, { result: [true] }, /not a boolean decision/],
      [200, { result: null }, /not a boolean decision/],
      [400, { code: 'invalid_parameter' }, /HTTP 400/],
      [500, { result: true }, /HTTP 500/],
      [200, { result: true, pad: 'x'.repeat(MAX_RESPONSE_BYTES) }, /too large/],
    ];
    for (const [status, body, pattern] of replies) {
      s.state.reply = (_b, _h, res) => send(res, status, body);
      await assert.rejects(authz.evaluate(sampleAccess()), pattern);
    }
    s.state.reply = (_b, _h, res) => { res.writeHead(307, { location: '/v1/data/agents/allow' }).end(); };
    await assert.rejects(authz.evaluate(sampleAccess()), /redirect|request failed/);
    assert.equal(s.seen.filter((r) => r.path === '/v1/data/agents/allow').length, 0);
    s.state.reply = () => new Promise(() => {});
    await assert.rejects(authz.evaluate(sampleAccess()), /timed out/);
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
        allow: [sampleAccess({ roles: ['viewer'] }), sampleAccess({ roles: ['analyst'], risk: 'write' }), sampleAccess({ kind: 'agent' })],
        deny: [sampleAccess(), sampleAccess({ roles: ['viewer'], risk: 'write' }), sampleAccess({ kind: 'agent', risk: 'exec' })],
      },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await s.close();
  }
});
