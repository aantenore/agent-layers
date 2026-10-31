import assert from 'node:assert/strict';
import { test } from 'node:test';
import { governedTools, type ToolPort } from '@agent-layers/core';
import { checkAdapter, sampleAccess } from '@agent-layers/conformance';
import { adapter, createAuthzen, LIMITS } from '../src/index.ts';
import { pdp, referencePolicy, request, send } from './helpers.ts';

const authzenPdp = () => pdp((body, _h, res) => {
  const d = referencePolicy(body);
  send(res, 200, { decision: d.allow, context: { reason_admin: { en: 'internal: rule 7' }, reason_user: { en: d.reason } } });
});

test('posts the AccessRequest to the evaluation endpoint, without arguments unless asked', async () => {
  const s = await authzenPdp();
  try {
    const user = { type: 'user', id: 'alice', properties: { roles: ['analyst'], scopes: [], authenticated: true } };
    const d = await createAuthzen({ url: `${s.url}/pdp/`, headers: { 'x-api-key': 'k', 'content-type': 'text/plain' } }).evaluate(request(user, 'write'));
    assert.deepEqual(d, { decision: true, context: { reason: 'allowed' } });
    assert.equal(s.seen[0]!.path, '/pdp/access/v1/evaluation');
    assert.equal(s.seen[0]!.headers['x-api-key'], 'k');
    assert.equal(s.seen[0]!.headers['content-type'], 'application/json');
    assert.deepEqual(s.seen[0]!.body, { ...request(user, 'write'), context: { channel: 'http' } });
    await createAuthzen({ url: s.url, includeArgs: true }).evaluate(request(user));
    assert.deepEqual(s.seen[1]!.body.context, { channel: 'http', args: { path: '/etc/secret' } });
  } finally {
    await s.close();
  }
});

test('deny carries the user-facing reason; the admin reason stays with the PDP', async () => {
  const s = await authzenPdp();
  try {
    const bob = { type: 'user', id: 'bob', properties: { roles: ['viewer'], authenticated: true } };
    assert.deepEqual(await createAuthzen({ url: s.url }).evaluate(request(bob, 'write')), { decision: false, context: { reason: 'user bob may not call write tools' } });
    s.state.reply = (_b, _h, res) => send(res, 200, { decision: false, context: { reason: 'x'.repeat(500) } });
    assert.equal((await createAuthzen({ url: s.url }).evaluate(request(bob))).context?.reason?.length, 200);
    s.state.reply = (_b, _h, res) => send(res, 200, { decision: false });
    assert.deepEqual(await createAuthzen({ url: s.url }).evaluate(request(bob)), { decision: false });
  } finally {
    await s.close();
  }
});

test('anonymous and malformed subjects reach the PDP as anonymous and never match agent rules', async () => {
  const s = await authzenPdp();
  try {
    const authz = createAuthzen({ url: s.url });
    const anon = { type: 'anonymous', id: 'anonymous', properties: { roles: [], scopes: [], authenticated: false } };
    for (const subject of [
      anon,
      { type: 'agent', id: 'notes', properties: { authenticated: false } },
      { type: 'Agent', id: 'notes', properties: { authenticated: true } },
      { type: 'agent', id: '', properties: { authenticated: true } },
      { type: 'service', id: 'notes', properties: { roles: ['analyst'], authenticated: true } },
    ]) {
      assert.equal((await authz.evaluate(request(subject))).decision, false, JSON.stringify(subject));
      assert.deepEqual(s.seen.at(-1)!.body.subject, anon);
    }
    assert.equal((await authz.evaluate(request({ type: 'agent', id: 'notes' }))).decision, true, 'authenticated agent reads');
    assert.equal(s.seen.at(-1)!.body.subject.properties.authenticated, true);

    // Through the stack: a call without identity is denied, the agent's own identity is allowed.
    const tools: ToolPort = { listTools: async () => [{ name: 'list', description: 'l', inputSchema: {}, risk: 'read' }], callTool: async () => ({ content: 'listed' }) };
    const governed = governedTools({ notes: tools }, { authorization: authz });
    const run = (identity?: { subject: string; kind: 'agent' }) => governed.callTool('notes__list', {}, { runId: 'r', agent: 'notes', ...(identity ? { identity } : {}) });
    assert.deepEqual(await run(), { content: 'Denied: anonymous anonymous may not call read tools', isError: true });
    assert.deepEqual(await run({ subject: 'svc', kind: 'agent' }), { content: 'listed' });
  } finally {
    await s.close();
  }
});

test('fails closed: missing or non-boolean decisions, errors, redirects, large or slow answers reject', async () => {
  const s = await authzenPdp();
  try {
    const authz = createAuthzen({ url: s.url, timeoutMs: 300 });
    const req = sampleAccess();
    const replies: [Parameters<typeof send>[1], unknown, RegExp][] = [
      [200, { decision: 'true' }, /no boolean "decision"/],
      [200, {}, /no boolean "decision"/],
      [200, [true], /not a JSON object/],
      [200, 'allow', /not JSON/],
      [500, { decision: true }, /HTTP 500/],
      [403, { decision: true }, /HTTP 403/],
      [302, '', /redirect|request failed/],
      [200, { decision: true, pad: 'x'.repeat(LIMITS.maxResponseBytes.default as number) }, /too large/],
    ];
    for (const [status, body, pattern] of replies) {
      s.state.reply = (_b, _h, res) => (status === 302 ? res.writeHead(302, { location: '/elsewhere' }).end() : send(res, status, body));
      await assert.rejects(authz.evaluate(req), pattern, `${status} ${JSON.stringify(body).slice(0, 40)}`);
    }
    s.state.reply = () => new Promise(() => {});
    await assert.rejects(authz.evaluate(req), /timed out after 300ms/);
    const ac = new AbortController();
    const pending = authz.evaluate(req, { signal: ac.signal });
    ac.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await assert.rejects(createAuthzen({ url: 'http://127.0.0.1:1' }).evaluate(req), /request failed/);
  } finally {
    await s.close();
  }
});

test('https is required outside loopback; bad paths are refused', () => {
  assert.throws(() => createAuthzen({ url: 'http://pdp.example.com' }), /https/);
  assert.throws(() => createAuthzen({ url: 'https://u:p@pdp.example.com' }), /credentials/);
  assert.throws(() => createAuthzen({ url: 'https://pdp.example.com', path: '../x' }), /path/);
  createAuthzen({ url: 'https://pdp.example.com' });
  createAuthzen({ url: 'http://pdp.internal', allowHttp: true });
});

test('authzen passes AuthorizationPort conformance', async () => {
  const s = await authzenPdp();
  try {
    const report = await checkAdapter(adapter, {
      options: { url: s.url },
      fixtures: {
        allow: [sampleAccess({ roles: ['viewer'] }), sampleAccess({ roles: ['analyst'], risk: 'write' }), sampleAccess({ kind: 'agent' })],
        deny: [sampleAccess(), sampleAccess({ roles: ['viewer'], risk: 'write' }), sampleAccess({ roles: ['analyst'], risk: 'exec' }), sampleAccess({ kind: 'agent', risk: 'write' })],
      },
    });
    assert.deepEqual(report.failures, []);
  } finally {
    await s.close();
  }
});
